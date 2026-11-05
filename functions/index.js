/*
 * Reminder sender for the Everything App.
 *
 * Runs once a minute. Finds every reminder whose time has come (across all
 * users), pushes a notification to that person's registered devices, and
 * marks the reminder sent.
 *
 * Making sure it actually arrives: when a phone shows the notification, it
 * reports back (ackReminder below). If no phone confirms within
 * CONFIRM_WITHIN_MS — or there's no phone to send to — the reminder is
 * emailed instead, so a broken notification never means a missed reminder.
 *
 * Cost safety: this function only runs on its fixed one-minute timer. Nothing
 * it writes can trigger it again, and only one copy ever runs at a time, so it
 * can't loop or fan out into a surprise bill.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import nodemailer from 'nodemailer';
import { randomBytes } from 'node:crypto';
import { nextOccurrence, isRepeating } from './recur.js';
import * as logger from 'firebase-functions/logger';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { getAuth } from 'firebase-admin/auth';

initializeApp();
const db = getFirestore();

const BATCH_LIMIT = 200;            // reminders handled per run (plenty)
const STALE_AFTER_MS = 24 * 3600e3; // older than this → mark sent quietly
const CONFIRM_WITHIN_MS = 2 * 60e3; // no "shown" from a phone by then → email it

// Backup emails go out from this Gmail account, using an app password stored
// as a Firebase secret: firebase functions:secrets:set MAIL_APP_PASSWORD
const MAIL_FROM = 'craig.willett@gmail.com';
const MAIL_APP_PASSWORD = defineSecret('MAIL_APP_PASSWORD');
function projectId() {
  if (process.env.GCLOUD_PROJECT) return process.env.GCLOUD_PROJECT;
  try { return JSON.parse(process.env.FIREBASE_CONFIG || '{}').projectId || ''; } catch (e) { return ''; }
}
const PROJECT_ID = projectId() || 'everything-app-1d851';
const ACK_URL = 'https://us-central1-' + PROJECT_ID + '.cloudfunctions.net/ackReminder';

let mailer = null;
function getMailer() {
  if (!mailer) {
    mailer = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: MAIL_FROM, pass: MAIL_APP_PASSWORD.value() }
    });
  }
  return mailer;
}

function escapeHtml(t) {
  return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function emailReminder(uid, r, why) {
  const user = await getAuth().getUser(uid).catch(() => null);
  const to = user && user.email;
  if (!to) return { ok: false, note: 'no email address on the account' };
  // lastDueAtMs: a repeating reminder's dueAtMs has already moved on to next time.
  const when = new Date(Number(r.lastDueAtMs) || Number(r.dueAtMs) || Date.now()).toLocaleString('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
  const title = String(r.title || 'Reminder').slice(0, 200);
  const body = String(r.description || '').slice(0, 2000);
  try {
    await getMailer().sendMail({
      from: '"Everything App" <' + MAIL_FROM + '>',
      to,
      subject: '⏰ Reminder: ' + title,
      text: title + (body ? '\n\n' + body : '') + '\n\n— ' + when + '\n' + why,
      html: '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#1c1f23">' +
        '<p style="font-size:18px;font-weight:600;margin:0 0 8px">⏰ ' + escapeHtml(title) + '</p>' +
        (body ? '<p style="margin:0 0 12px;white-space:pre-wrap">' + escapeHtml(body) + '</p>' : '') +
        '<p style="color:#667085;font-size:13px;margin:12px 0 0">' + escapeHtml(when) + ' · ' + escapeHtml(why) + '</p></div>'
    });
    return { ok: true };
  } catch (e) {
    logger.error('Backup email failed', { message: e.message });
    return { ok: false, note: 'email failed: ' + e.message };
  }
}

function ruleOf(r) {
  return { repeat: r.repeat, days: r.repeatDays, anchor: r.repeatAnchor, time: r.repeatTime, until: r.repeatUntil, tz: r.tz };
}

// A repeating reminder goes straight back to "upcoming" for its next time.
// Missed occurrences (phone off, app down) are skipped, never piled up.
async function scheduleNext(doc, r, now) {
  const rule = ruleOf(r);
  if (!isRepeating(rule)) return false;
  const next = nextOccurrence(rule, Math.max(now, Number(r.dueAtMs) || 0));
  if (!next) return false;   // reached its "until" date — it stays in Sent
  await doc.ref.update({ status: 'pending', dueAtMs: next, nextAtMs: next, lastSentAt: new Date().toISOString() });
  return true;
}

async function reminderEmailMode(uid) {
  const snap = await db.collection('users').doc(uid).collection('meta').doc('settings').get().catch(() => null);
  const mode = snap && snap.exists ? snap.data().reminderEmail : null;
  return mode === 'always' || mode === 'off' ? mode : 'backup';
}

/*
 * Reminders live in two places: users/{uid}/reminders (private) and
 * shared/{id} with table 'reminders' (shared with the uids in `members`).
 * Each person it's for gets their own push, their own "shown" confirmation
 * (ackKeys.{uid}) and their own backup email; receipts are in deliveries.{uid}.
 */
function isShared(doc) { return doc.ref.parent.id === 'shared'; }
function recipientsOf(doc, r) {
  if (isShared(doc)) return Array.isArray(r.members) ? r.members.filter((u) => typeof u === 'string') : [];
  const userRef = doc.ref.parent.parent;
  return userRef ? [userRef.id] : [];
}

async function dueReminders(field, now) {
  const [own, shared] = await Promise.all([
    db.collectionGroup('reminders').where(field, '<=', now).orderBy(field).limit(BATCH_LIMIT).get(),
    db.collection('shared').where(field, '<=', now).orderBy(field).limit(BATCH_LIMIT).get()
  ]);
  return own.docs.concat(shared.docs.filter((d) => d.data().table === 'reminders'));
}

function cleanupFields() {
  // Older single-person receipt fields; replaced by deliveries/ackKeys.
  return { delivery: FieldValue.delete(), ackKey: FieldValue.delete(), ackedAt: FieldValue.delete(),
    emailedAt: FieldValue.delete(), deliveryNote: FieldValue.delete(), pushedTo: FieldValue.delete() };
}

async function pushTo(uid, r, doc, ackKey, tokensByUser) {
  const userRef = db.collection('users').doc(uid);
  if (!tokensByUser.has(uid)) {
    const devices = await userRef.collection('devices').get();
    tokensByUser.set(uid, devices.docs.map((d) => d.id));
  }
  const tokens = tokensByUser.get(uid);
  if (!tokens.length) return { devices: 0, success: 0 };
  const res = await getMessaging().sendEachForMulticast({
    tokens,
    data: {
      title: String(r.title || 'Reminder').slice(0, 200),
      body: String(r.description || '').slice(0, 1000),
      reminderId: doc.id,
      dueAtMs: String(r.dueAtMs || ''),
      uid,
      ackKey,
      ackUrl: ACK_URL,
      s: isShared(doc) ? '1' : ''
    },
    webpush: { headers: { Urgency: 'high', TTL: '86400' } }
  });
  // Drop devices that have been uninstalled or had notifications revoked.
  const dead = [];
  res.responses.forEach((resp, i) => {
    if (resp.success) return;
    const code = String((resp.error && (resp.error.code || resp.error.message)) || '');
    if (/not-registered|invalid-registration|registration-token|unregistered|invalid-argument/i.test(code)) dead.push(tokens[i]);
    else logger.warn('Push failed', { code });
  });
  for (const t of dead) await userRef.collection('devices').doc(t).delete().catch(() => {});
  if (dead.length) {
    tokensByUser.set(uid, tokens.filter((t) => !dead.includes(t)));
    logger.warn('Removed devices that no longer accept notifications', { user: uid, count: dead.length });
  }
  return { devices: tokens.length, success: res.successCount };
}

export const sendDueReminders = onSchedule(
  {
    schedule: 'every 1 minutes',
    timeZone: 'America/New_York',
    memory: '256MiB',
    timeoutSeconds: 60,
    maxInstances: 1,
    retryCount: 0,
    secrets: [MAIL_APP_PASSWORD]
  },
  async () => {
    const now = Date.now();
    await sendBackupEmails(now);
    // nextAtMs only exists on reminders still waiting to go out.
    const due = await dueReminders('nextAtMs', now);
    if (!due.length) return;

    const tokensByUser = new Map();
    let sent = 0;

    for (const doc of due) {
      const r = doc.data();
      const people = recipientsOf(doc, r);
      if (!people.length) continue;

      // Claim it first, so a slow run can't send the same reminder twice.
      const ackKeys = {};
      const deliveries = {};
      people.forEach((uid) => { ackKeys[uid] = randomBytes(12).toString('hex'); deliveries[uid] = { state: 'sending' }; });
      try {
        await doc.ref.update(Object.assign(
          { nextAtMs: FieldValue.delete(), status: 'sent', sentAt: new Date().toISOString(),
            lastDueAtMs: Number(r.dueAtMs) || now, ackKeys, deliveries,
            emailPending: FieldValue.delete(), emailDueMs: FieldValue.delete() },
          cleanupFields()), { lastUpdateTime: doc.updateTime });
      } catch (e) {
        continue; // changed or deleted since we read it — next run will see the new state
      }

      if (now - Number(r.dueAtMs || r.nextAtMs) > STALE_AFTER_MS) {
        const skipped = {};
        people.forEach((uid) => { skipped[uid] = { state: 'skipped', note: 'more than a day late' }; });
        await doc.ref.update({ deliveries: skipped }).catch(() => {});
        await scheduleNext(doc, r, now).catch((e) => logger.error('Could not schedule next', { message: e.message }));
        continue;
      }

      const pending = [];
      for (const uid of people) {
        const mode = await reminderEmailMode(uid);
        const push = await pushTo(uid, r, doc, ackKeys[uid], tokensByUser);
        sent += push.success;
        let d;
        if (mode === 'always') {
          const mail = await emailReminder(uid, r, 'You asked for every reminder by email too.');
          d = push.success ? { state: 'pushed', emailed: mail.ok } : (mail.ok ? { state: 'emailed', note: 'no phone could get the notification' } : { state: 'failed', note: mail.note });
        } else if (push.success) {
          d = { state: 'pushed' };
          // Email as a backup unless a phone confirms it showed the reminder.
          if (mode === 'backup') pending.push(uid);
        } else if (mode === 'backup') {
          const mail = await emailReminder(uid, r, 'Sent by email because no phone could get the notification.');
          d = mail.ok ? { state: 'emailed', note: 'no phone could get the notification' } : { state: 'failed', note: mail.note };
        } else {
          d = { state: 'failed', note: 'no phone has notifications on' };
        }
        deliveries[uid] = d;
        logger.info('Reminder', { user: uid, reminder: doc.id, shared: isShared(doc), devices: push.devices, pushed: push.success, delivery: d.state });
      }
      // A phone may already have confirmed while we were sending — keep that.
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(doc.ref);
        if (!snap.exists) return;
        const cur = snap.data().deliveries || {};
        const merged = {};
        people.forEach((uid) => { merged[uid] = cur[uid] && cur[uid].state === 'shown' ? cur[uid] : deliveries[uid]; });
        const stillPending = pending.filter((uid) => merged[uid].state !== 'shown');
        tx.update(doc.ref, Object.assign({ deliveries: merged },
          stillPending.length ? { emailPending: stillPending, emailDueMs: Date.now() + CONFIRM_WITHIN_MS } : {}));
      }).catch((e) => logger.error('Could not save receipts', { message: e.message }));
      await scheduleNext(doc, r, now).catch((e) => logger.error('Could not schedule next', { message: e.message }));
    }
    logger.info('Reminders processed', { due: due.length, notificationsSent: sent });
  }
);

// Pushed reminders no phone has confirmed in time get emailed.
async function sendBackupEmails(now) {
  const late = await dueReminders('emailDueMs', now);
  for (const doc of late) {
    // Claim it, so it can only be emailed once.
    try {
      await doc.ref.update({ emailDueMs: FieldValue.delete(), emailPending: FieldValue.delete() }, { lastUpdateTime: doc.updateTime });
    } catch (e) { continue; }
    const r = doc.data();
    const deliveries = r.deliveries || {};
    const update = {};
    for (const uid of (Array.isArray(r.emailPending) ? r.emailPending : [])) {
      if (deliveries[uid] && deliveries[uid].state === 'shown') continue;
      const mail = await emailReminder(uid, r, 'Sent by email because your phone didn’t confirm the notification.');
      update['deliveries.' + uid] = mail.ok
        ? { state: 'emailed', note: 'your phone didn’t confirm the notification' }
        : { state: 'unconfirmed', note: mail.note };
      logger.warn('Reminder not confirmed by a phone', { user: uid, reminder: doc.id, emailed: mail.ok });
    }
    if (Object.keys(update).length) await doc.ref.update(update).catch(() => {});
  }
}

// A phone calls this when it has shown a reminder notification.
export const ackReminder = onRequest({ memory: '256MiB', timeoutSeconds: 10, maxInstances: 5, invoker: 'public', cors: true }, async (req, res) => {
  let b;
  if (req.method === 'GET') b = req.query || {};
  else if (req.method === 'POST') {
    b = req.body;
    if (typeof b === 'string' || Buffer.isBuffer(b)) { try { b = JSON.parse(String(b)); } catch (e) { b = {}; } }
  } else { res.status(405).send(''); return; }
  b = b || {};
  if (req.method === 'GET' && !b.key) { res.status(405).send(''); return; }   // a browser visit
  const uid = String(b.uid || ''), rid = String(b.rid || ''), key = String(b.key || '');
  const shared = String(b.s || '') === '1';
  if (!/^[\w-]{1,128}$/.test(uid) || !/^[\w-]{1,128}$/.test(rid) || !/^[0-9a-f]{24}$/.test(key)) {
    logger.warn('Ack rejected: bad request', { method: req.method, uid: uid.slice(0, 40), rid: rid.slice(0, 60), keyLen: key.length });
    res.status(400).send(''); return;
  }
  const ref = shared ? db.collection('shared').doc(rid) : db.collection('users').doc(uid).collection('reminders').doc(rid);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = snap.exists ? snap.data() : null;
      if (!d || !d.ackKeys || d.ackKeys[uid] !== key) throw new Error('mismatch');
      const prev = (d.deliveries || {})[uid] || {};
      const pending = (Array.isArray(d.emailPending) ? d.emailPending : []).filter((u) => u !== uid);
      tx.update(ref, Object.assign({
        // Keep "emailed" if the backup already went out (phone was very late).
        ['deliveries.' + uid]: prev.state === 'emailed'
          ? { state: 'emailed', note: 'your phone showed it late, after the email' }
          : { state: 'shown', at: new Date().toISOString() }
      }, pending.length ? { emailPending: pending } : { emailPending: FieldValue.delete(), emailDueMs: FieldValue.delete() }));
    });
    logger.info('Ack received', { method: req.method, user: uid, reminder: rid, shared });
    res.status(204).send('');
  } catch (e) {
    logger.warn('Ack rejected', { method: req.method, user: uid, reminder: rid, shared, why: e.message });
    res.status(404).send('');
  }
});

/* ------------------------------------------------------------ admin -- */
/*
 * Admin dashboard numbers. Only the accounts listed here may call it, and it
 * only ever returns counts — never anyone's task, note or reminder text.
 */
const ADMIN_EMAILS = ['craig.willett@gmail.com'];
const TIME_ZONE = 'America/New_York';

// Midnight today in the admin's time zone, as an ISO string (records store
// their "created" time as ISO strings, which sort correctly as text).
function startOfTodayIso() {
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: TIME_ZONE }));
  const offset = Math.round((local.getTime() - now.getTime()) / 60000) * 60000;
  local.setHours(0, 0, 0, 0);
  return new Date(local.getTime() - offset).toISOString();
}

async function count(query) {
  try {
    const snap = await query.count().get();
    return snap.data().count;
  } catch (e) {
    logger.warn('count failed', { message: e.message });
    return null;
  }
}

export const adminStats = onCall({ memory: '256MiB', timeoutSeconds: 60, maxInstances: 2 }, async (req) => {
  const token = (req.auth && req.auth.token) || {};
  const email = String(token.email || '').toLowerCase();
  if (!req.auth || !token.email_verified || !ADMIN_EMAILS.includes(email)) {
    throw new HttpsError('permission-denied', 'This page is only for the app admin.');
  }

  const today = startOfTodayIso();
  const accounts = [];
  let pageToken;
  do {
    const page = await getAuth().listUsers(1000, pageToken);
    accounts.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);

  const users = await Promise.all(accounts.map(async (u) => {
    const base = db.collection('users').doc(u.uid);
    const col = (name) => base.collection(name);
    const totalAndToday = async (name) => ({
      total: await count(col(name)),
      today: await count(col(name).where('created', '>=', today))
    });
    const [tasks, notes, reminders, links] = await Promise.all(
      ['tasks', 'notes', 'reminders', 'links'].map(totalAndToday));
    const sharedCount = await count(db.collection('shared').where('members', 'array-contains', u.uid));
    const [tasksInToday, tasksDone, tasksArchived, lists, remindersUpcoming, devices] = await Promise.all([
      count(col('tasks').where('today', '==', true)),
      count(col('tasks').where('status', '==', 'Done')),
      count(col('tasks').where('archived', '==', true)),
      count(col('notes').where('kind', '==', 'list')),
      count(col('reminders').where('status', '==', 'pending')),
      count(col('devices'))
    ]);
    return {
      uid: u.uid,
      name: u.displayName || '',
      email: u.email || '',
      provider: (u.providerData[0] && u.providerData[0].providerId) || 'password',
      created: u.metadata.creationTime || null,
      lastSignIn: u.metadata.lastRefreshTime || u.metadata.lastSignInTime || null,
      disabled: !!u.disabled,
      tasks: Object.assign(tasks, { inToday: tasksInToday, done: tasksDone, archived: tasksArchived }),
      notes: Object.assign(notes, { lists: lists }),
      reminders: Object.assign(reminders, { upcoming: remindersUpcoming }),
      links,
      devices,
      shared: sharedCount
    };
  }));

  users.sort((a, b) => String(b.lastSignIn || '').localeCompare(String(a.lastSignIn || '')));
  return { generatedAt: new Date().toISOString(), todayStartsAt: today, timeZone: TIME_ZONE, users };
});

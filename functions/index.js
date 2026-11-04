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
const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || '';
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

async function emailReminder(userRef, r, why) {
  const user = await getAuth().getUser(userRef.id).catch(() => null);
  const to = user && user.email;
  if (!to) return { ok: false, note: 'no email address on the account' };
  const when = new Date(Number(r.dueAtMs) || Date.now()).toLocaleString('en-US', {
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

async function reminderEmailMode(userRef) {
  const snap = await userRef.collection('meta').doc('settings').get().catch(() => null);
  const mode = snap && snap.exists ? snap.data().reminderEmail : null;
  return mode === 'always' || mode === 'off' ? mode : 'backup';
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
    const due = await db.collectionGroup('reminders')
      .where('nextAtMs', '<=', now)
      .orderBy('nextAtMs')
      .limit(BATCH_LIMIT)
      .get();
    if (due.empty) return;

    const tokensByUser = new Map();
    let sent = 0;

    for (const doc of due.docs) {
      const userRef = doc.ref.parent.parent;           // users/{uid}
      if (!userRef) continue;
      const r = doc.data();

      // Claim it first, so a slow run can't send the same reminder twice.
      const ackKey = randomBytes(12).toString('hex');
      try {
        await doc.ref.update(
          { nextAtMs: FieldValue.delete(), status: 'sent', sentAt: new Date().toISOString(),
            delivery: 'sending', ackKey },
          { lastUpdateTime: doc.updateTime }
        );
      } catch (e) {
        continue; // changed or deleted since we read it — next run will see the new state
      }

      if (now - Number(r.dueAtMs || r.nextAtMs) > STALE_AFTER_MS) {
        await doc.ref.update({ delivery: 'skipped', deliveryNote: 'more than a day late' }).catch(() => {});
        continue;
      }

      const mode = await reminderEmailMode(userRef);
      if (!tokensByUser.has(userRef.id)) {
        const devices = await userRef.collection('devices').get();
        tokensByUser.set(userRef.id, devices.docs.map((d) => d.id));
      }
      const tokens = tokensByUser.get(userRef.id);

      let successCount = 0;
      if (tokens.length) {
        const res = await getMessaging().sendEachForMulticast({
          tokens,
          data: {
            title: String(r.title || 'Reminder').slice(0, 200),
            body: String(r.description || '').slice(0, 1000),
            reminderId: doc.id,
            dueAtMs: String(r.dueAtMs || ''),
            uid: userRef.id,
            ackKey,
            ackUrl: ACK_URL
          },
          webpush: { headers: { Urgency: 'high', TTL: '86400' } }
        });
        successCount = res.successCount;
        sent += res.successCount;

        // Drop devices that have been uninstalled or had notifications revoked.
        const dead = [];
        res.responses.forEach((resp, i) => {
          if (resp.success) return;
          const code = String((resp.error && (resp.error.code || resp.error.message)) || '');
          if (/not-registered|invalid-registration|registration-token|unregistered|invalid-argument/i.test(code)) dead.push(tokens[i]);
          else logger.warn('Push failed', { code });
        });
        for (const t of dead) {
          await userRef.collection('devices').doc(t).delete().catch(() => {});
        }
        if (dead.length) {
          tokensByUser.set(userRef.id, tokens.filter((t) => !dead.includes(t)));
          logger.warn('Removed devices that no longer accept notifications', { user: userRef.id, count: dead.length });
        }
      }

      const update = { pushedTo: successCount };
      if (mode === 'always') {
        const mail = await emailReminder(userRef, r, 'You asked for every reminder by email too.');
        update.emailedAt = mail.ok ? new Date().toISOString() : FieldValue.delete();
        update.delivery = successCount ? 'pushed' : (mail.ok ? 'emailed' : 'failed');
        if (!mail.ok) update.deliveryNote = mail.note;
      } else if (successCount) {
        update.delivery = 'pushed';
        // Email as a backup unless a phone confirms it showed the reminder.
        if (mode === 'backup') update.emailDueMs = Date.now() + CONFIRM_WITHIN_MS;
      } else if (mode === 'backup') {
        const mail = await emailReminder(userRef, r, 'Sent by email because no phone could get the notification.');
        update.delivery = mail.ok ? 'emailed' : 'failed';
        update.deliveryNote = mail.ok ? 'no phone could get the notification' : mail.note;
        if (mail.ok) update.emailedAt = new Date().toISOString();
      } else {
        update.delivery = 'failed';
        update.deliveryNote = 'no phone has notifications on';
      }
      await doc.ref.update(update).catch(() => {});
      logger.info('Reminder', { user: userRef.id, reminder: doc.id, devices: tokens.length, pushed: successCount, delivery: update.delivery });
    }
    logger.info('Reminders processed', { due: due.size, notificationsSent: sent });
  }
);


// Pushed reminders no phone has confirmed in time get emailed.
async function sendBackupEmails(now) {
  const late = await db.collectionGroup('reminders')
    .where('emailDueMs', '<=', now)
    .orderBy('emailDueMs')
    .limit(BATCH_LIMIT)
    .get();
  for (const doc of late.docs) {
    const userRef = doc.ref.parent.parent;
    if (!userRef) continue;
    // Claim it, so it can only be emailed once.
    try {
      await doc.ref.update({ emailDueMs: FieldValue.delete() }, { lastUpdateTime: doc.updateTime });
    } catch (e) { continue; }
    const r = doc.data();
    if (r.ackedAt) continue;
    const mail = await emailReminder(userRef, r, 'Sent by email because your phone didn\u2019t confirm the notification.');
    await doc.ref.update(mail.ok
      ? { delivery: 'emailed', emailedAt: new Date().toISOString(), deliveryNote: 'your phone didn\u2019t confirm the notification' }
      : { delivery: 'unconfirmed', deliveryNote: mail.note }).catch(() => {});
    logger.warn('Reminder not confirmed by a phone', { user: userRef.id, reminder: doc.id, emailed: mail.ok });
  }
}

// A phone calls this when it has shown a reminder notification.
export const ackReminder = onRequest({ memory: '128MiB', timeoutSeconds: 10, maxInstances: 5, invoker: 'public', cors: true }, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).send(''); return; }
  let b = req.body;
  if (typeof b === 'string' || Buffer.isBuffer(b)) { try { b = JSON.parse(String(b)); } catch (e) { b = {}; } }
  b = b || {};
  const uid = String(b.uid || ''), rid = String(b.rid || ''), key = String(b.key || '');
  if (!/^[\w-]{1,128}$/.test(uid) || !/^[\w-]{1,128}$/.test(rid) || !/^[0-9a-f]{24}$/.test(key)) { res.status(400).send(''); return; }
  const ref = db.collection('users').doc(uid).collection('reminders').doc(rid);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.data().ackKey !== key) throw new Error('mismatch');
      const d = snap.data();
      tx.update(ref, {
        ackedAt: new Date().toISOString(),
        emailDueMs: FieldValue.delete(),
        // Keep "emailed" if the backup already went out (phone was very late).
        delivery: d.delivery === 'emailed' ? 'emailed' : 'shown',
        deliveryNote: d.delivery === 'emailed' ? 'your phone showed it late, after the email' : FieldValue.delete()
      });
    });
    res.status(204).send('');
  } catch (e) {
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
      devices
    };
  }));

  users.sort((a, b) => String(b.lastSignIn || '').localeCompare(String(a.lastSignIn || '')));
  return { generatedAt: new Date().toISOString(), todayStartsAt: today, timeZone: TIME_ZONE, users };
});

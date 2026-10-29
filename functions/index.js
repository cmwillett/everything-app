/*
 * Reminder sender for the Everything App.
 *
 * Runs once a minute. Finds every reminder whose time has come (across all
 * users), pushes a notification to that person's registered devices, and
 * marks the reminder sent.
 *
 * Cost safety: this function only runs on its fixed one-minute timer. Nothing
 * it writes can trigger it again, and only one copy ever runs at a time, so it
 * can't loop or fan out into a surprise bill.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { getAuth } from 'firebase-admin/auth';

initializeApp();
const db = getFirestore();

const BATCH_LIMIT = 200;            // reminders handled per run (plenty)
const STALE_AFTER_MS = 24 * 3600e3; // older than this → mark sent quietly

export const sendDueReminders = onSchedule(
  {
    schedule: 'every 1 minutes',
    timeZone: 'America/New_York',
    memory: '256MiB',
    timeoutSeconds: 60,
    maxInstances: 1,
    retryCount: 0
  },
  async () => {
    const now = Date.now();
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
      try {
        await doc.ref.update(
          { nextAtMs: FieldValue.delete(), status: 'sent', sentAt: new Date().toISOString() },
          { lastUpdateTime: doc.updateTime }
        );
      } catch (e) {
        continue; // changed or deleted since we read it — next run will see the new state
      }

      if (now - Number(r.dueAtMs || r.nextAtMs) > STALE_AFTER_MS) continue;

      if (!tokensByUser.has(userRef.id)) {
        const devices = await userRef.collection('devices').get();
        tokensByUser.set(userRef.id, devices.docs.map((d) => d.id));
      }
      const tokens = tokensByUser.get(userRef.id);
      if (!tokens.length) continue;

      const res = await getMessaging().sendEachForMulticast({
        tokens,
        data: {
          title: String(r.title || 'Reminder').slice(0, 200),
          body: String(r.description || '').slice(0, 1000),
          reminderId: doc.id,
          dueAtMs: String(r.dueAtMs || '')
        },
        webpush: { headers: { Urgency: 'high', TTL: '86400' } }
      });
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
      if (dead.length) tokensByUser.set(userRef.id, tokens.filter((t) => !dead.includes(t)));
    }
    logger.info('Reminders processed', { due: due.size, notificationsSent: sent });
  }
);


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

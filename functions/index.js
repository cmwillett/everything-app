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
import * as logger from 'firebase-functions/logger';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

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

import { db, type Db } from '../db';
import { sendPlainEmail } from './email.service';

/** Queue a notification (in-app + email). A repeated dedupe_key is ignored, so jobs can safely re-run. */
export async function notify(
  userId: number, triggerKey: string, subject: string, body: string, dedupeKey?: string, d: Db = db
): Promise<void> {
  await d.execute(
    'INSERT IGNORE INTO notifications (user_id, trigger_key, subject, body, dedupe_key) VALUES (?,?,?,?,?)',
    [userId, triggerKey, subject.slice(0, 200), body, dedupeKey ?? null]
  );
}

const MAX_ATTEMPTS = 5;

/** Delivers queued emails; transient failures are retried on later runs, then marked failed. */
export async function deliverQueued(limit = 25): Promise<number> {
  const rows = await db.query<{ id: number; subject: string; body: string; email: string; attempts: number }>(
    `SELECT n.id, n.subject, n.body, n.attempts, u.email FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE n.delivery_status = 'queued' AND n.attempts < ? ORDER BY n.id LIMIT ?`,
    [MAX_ATTEMPTS, limit]
  );
  let sent = 0;
  for (const n of rows) {
    const ok = await sendPlainEmail(n.email, n.subject, n.body);
    if (ok) {
      await db.execute(
        "UPDATE notifications SET delivery_status = 'sent', sent_at = UTC_TIMESTAMP(), attempts = attempts + 1 WHERE id = ?",
        [n.id]
      );
      sent++;
    } else {
      const failed = n.attempts + 1 >= MAX_ATTEMPTS;
      await db.execute(
        "UPDATE notifications SET attempts = attempts + 1, delivery_status = ?, last_error = 'SMTP delivery failed' WHERE id = ?",
        [failed ? 'failed' : 'queued', n.id]
      );
    }
  }
  return sent;
}

export const listForUser = (userId: number, limit = 50) =>
  db.query(
    `SELECT id, trigger_key AS triggerKey, subject, body, read_at AS readAt, created_at AS createdAt
       FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
    [userId, limit]
  );
export const unreadCount = async (userId: number) =>
  Number((await db.one<{ c: number }>('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND read_at IS NULL', [userId]))!.c);
export const markAllRead = (userId: number) =>
  db.execute('UPDATE notifications SET read_at = UTC_TIMESTAMP() WHERE user_id = ? AND read_at IS NULL', [userId]);

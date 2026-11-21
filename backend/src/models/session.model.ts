import { execute, one, query } from '../db';
import type { Role, User } from './user.model';

export interface SessionRow {
  id: string;
  user_id: number;
  refresh_token_hash: string;
  prev_refresh_token_hash: string | null;
  device_name: string | null;
  browser: string | null;
  os: string | null;
  ip_address: string | null;
  is_active: number;
  created_at: Date;
  last_active_at: Date;
  expires_at: Date;
}

export const SessionModel = {
  insert: (s: {
    id: string; userId: number; refreshHash: string; familyId: string; deviceName: string;
    browser: string; os: string; ip: string | null; userAgent: string; expiresAt: Date;
  }) =>
    execute(
      `INSERT INTO user_sessions
        (id, user_id, refresh_token_hash, token_family_id, device_name, browser, os, ip_address, user_agent, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [s.id, s.userId, s.refreshHash, s.familyId, s.deviceName, s.browser, s.os, s.ip, s.userAgent, s.expiresAt]
    ),

  activeIdsOldestFirst: async (userId: number) =>
    (await query<{ id: string }>(
      'SELECT id FROM user_sessions WHERE user_id = ? AND is_active = 1 AND expires_at > UTC_TIMESTAMP() ORDER BY last_active_at ASC',
      [userId]
    )).map((r) => r.id),

  revokeMany: (ids: string[], reason: string) =>
    execute(
      'UPDATE user_sessions SET is_active = 0, revoked_at = UTC_TIMESTAMP(), revoked_reason = ? WHERE id IN (?)',
      [reason, ids]
    ),

  findWithUser: (sid: string) =>
    one<SessionRow & { role: Role; status: User['status']; email: string; full_name: string }>(
      `SELECT s.*, u.role, u.status, u.email, u.full_name
         FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
      [sid]
    ),

  findForAuth: (sid: string, userId: number) =>
    one<{ is_active: number; expires_at: Date; last_active_at: Date; role: Role; status: User['status'] }>(
      `SELECT s.is_active, s.expires_at, s.last_active_at, u.role, u.status
         FROM user_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.user_id = ?`,
      [sid, userId]
    ),

  /** Compare-and-swap rotation: only succeeds if the presented hash is still the current one. */
  rotate: async (sid: string, presentedHash: string, newHash: string) =>
    (await execute(
      `UPDATE user_sessions
          SET prev_refresh_token_hash = refresh_token_hash, refresh_token_hash = ?, last_active_at = UTC_TIMESTAMP()
        WHERE id = ? AND refresh_token_hash = ? AND is_active = 1`,
      [newHash, sid, presentedHash]
    )).affectedRows === 1,

  revokeOne: async (sid: string, userId: number, reason: string) =>
    (await execute(
      `UPDATE user_sessions SET is_active = 0, revoked_at = UTC_TIMESTAMP(), revoked_reason = ?
        WHERE id = ? AND user_id = ? AND is_active = 1`,
      [reason, sid, userId]
    )).affectedRows === 1,

  revokeAllForUser: async (userId: number, reason: string, exceptSid: string | null) =>
    (await execute(
      `UPDATE user_sessions SET is_active = 0, revoked_at = UTC_TIMESTAMP(), revoked_reason = ?
        WHERE user_id = ? AND is_active = 1 AND (? IS NULL OR id <> ?)`,
      [reason, userId, exceptSid, exceptSid]
    )).affectedRows,

  listActive: (userId: number) =>
    query<SessionRow>(
      `SELECT id, device_name, browser, os, ip_address, created_at, last_active_at, expires_at
         FROM user_sessions
        WHERE user_id = ? AND is_active = 1 AND expires_at > UTC_TIMESTAMP()
        ORDER BY last_active_at DESC`,
      [userId]
    ),

  findOwner: (sid: string) =>
    one<{ id: string; user_id: number; role: Role }>(
      'SELECT s.id, s.user_id, u.role FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?',
      [sid]
    ),

  touch: (sid: string) => execute('UPDATE user_sessions SET last_active_at = UTC_TIMESTAMP() WHERE id = ?', [sid]),

  // --- access-token denylist (revoked_tokens) ---
  denylistJti: (jti: string, sid: string | null, userId: number, expSeconds: number) =>
    execute('INSERT IGNORE INTO revoked_tokens (jti, session_id, user_id, expires_at) VALUES (?,?,?,?)', [
      jti, sid, userId, new Date(expSeconds * 1000),
    ]),
  isJtiDenied: async (jti: string) => !!(await one('SELECT 1 AS x FROM revoked_tokens WHERE jti = ? LIMIT 1', [jti])),

  cleanupExpired: async () => {
    await execute('DELETE FROM revoked_tokens WHERE expires_at < UTC_TIMESTAMP()');
    await execute(
      "UPDATE user_sessions SET is_active = 0, revoked_at = UTC_TIMESTAMP(), revoked_reason = 'expired' WHERE is_active = 1 AND expires_at <= UTC_TIMESTAMP()"
    );
  },
};

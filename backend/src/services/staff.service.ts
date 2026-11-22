import argon2 from 'argon2';
import { v4 as uuid } from 'uuid';
import { db } from '../db';
import { ApiError, type ReqCtx } from '../utils/http';
import { audit } from './audit.service';
import { sendSecurityEmail } from './email.service';
import { revokeAllSessions } from './session.service';

type Staff = { userId: number; role: string; sid: string };
export const STAFF_ROLE_LIST = ['super_admin', 'admin', 'finance_officer', 'auditor'] as const;

export const listStaff = () =>
  db.query(
    `SELECT public_id AS id, full_name AS fullName, email, role, status, last_login_at AS lastLoginAt, created_at AS createdAt
       FROM users WHERE role <> 'customer' ORDER BY id`
  );

export async function createStaff(i: { fullName: string; email: string; role: (typeof STAFF_ROLE_LIST)[number]; password: string }, staff: Staff, ctx: ReqCtx) {
  if (await db.one('SELECT id FROM users WHERE email = ?', [i.email])) throw new ApiError(409, 'A user with this email already exists', 'DUPLICATE');
  const hash = await argon2.hash(i.password, { type: argon2.argon2id });
  const publicId = uuid();
  const r = await db.execute(
    "INSERT INTO users (public_id, email, password_hash, role, status, full_name, email_verified_at) VALUES (?,?,?,?, 'active', ?, UTC_TIMESTAMP())",
    [publicId, i.email, hash, i.role, i.fullName]
  );
  void sendSecurityEmail(i.email, i.fullName, `A ${i.role.replace('_', ' ')} account was created for you. Sign in and change your password immediately.`);
  await audit(ctx, { action: 'staff.create', entity: 'user', entityId: r.insertId, after: { email: i.email, role: i.role }, actor: staff });
  return { id: publicId };
}

export async function updateStaff(publicId: string, i: { role?: (typeof STAFF_ROLE_LIST)[number]; status?: 'active' | 'suspended' }, staff: Staff, ctx: ReqCtx) {
  const u = await db.one<any>("SELECT id, role, status FROM users WHERE public_id = ? AND role <> 'customer'", [publicId]);
  if (!u) throw new ApiError(404, 'Staff user not found', 'NOT_FOUND');
  if (u.id === staff.userId) throw new ApiError(403, 'You cannot change your own role or status', 'FORBIDDEN');
  if (i.role) await db.execute('UPDATE users SET role = ? WHERE id = ?', [i.role, u.id]);
  if (i.status) await db.execute('UPDATE users SET status = ? WHERE id = ?', [i.status, u.id]);
  if (i.status === 'suspended' || i.role) await revokeAllSessions(u.id, 'staff_changed'); // new role/status applies on next login
  await audit(ctx, { action: 'staff.update', entity: 'user', entityId: u.id, before: { role: u.role, status: u.status }, after: i, actor: staff });
}

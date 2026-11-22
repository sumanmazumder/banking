import { execute, one } from '../db';

export type Role = 'super_admin' | 'admin' | 'finance_officer' | 'auditor' | 'customer';

export interface User {
  id: number;
  public_id: string;
  email: string;
  mobile: string | null;
  password_hash: string;
  role: Role;
  status: 'draft' | 'kyc_pending' | 'under_review' | 'active' | 'rejected' | 'suspended' | 'closed';
  full_name: string;
  email_verified_at: Date | null;
  failed_login_count: number;
  locked_until: Date | null;
  created_at: Date;
}

export const UserModel = {
  findByEmail: (email: string) => one<User>('SELECT * FROM users WHERE email = ?', [email]),
  findById: (id: number) => one<User>('SELECT * FROM users WHERE id = ?', [id]),
  findByPublicId: (publicId: string) => one<User>('SELECT * FROM users WHERE public_id = ?', [publicId]),
  existsByEmailOrMobile: async (email: string, mobile: string) =>
    !!(await one('SELECT id FROM users WHERE email = ? OR mobile = ?', [email, mobile])),

  async createCustomer(d: { publicId: string; email: string; mobile: string; passwordHash: string; fullName: string }) {
    const res = await execute(
      `INSERT INTO users (public_id, email, mobile, password_hash, role, status, full_name, consent_accepted_at)
       VALUES (?,?,?,?, 'customer', 'draft', ?, UTC_TIMESTAMP())`,
      [d.publicId, d.email, d.mobile, d.passwordHash, d.fullName]
    );
    await execute('INSERT INTO customer_profiles (user_id) VALUES (?)', [res.insertId]);
    return res.insertId;
  },

  markEmailVerified: (id: number) =>
    execute(
      "UPDATE users SET email_verified_at = COALESCE(email_verified_at, UTC_TIMESTAMP()), status = IF(status = 'draft', 'kyc_pending', status) WHERE id = ?",
      [id]
    ),

  updatePassword: (id: number, passwordHash: string) =>
    execute('UPDATE users SET password_hash = ?, failed_login_count = 0, locked_until = NULL WHERE id = ?', [passwordHash, id]),

  recordFailedLogin: (id: number, failedCount: number, maxFailed: number, lockMinutes: number) =>
    execute(
      'UPDATE users SET failed_login_count = ?, locked_until = IF(? >= ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), NULL) WHERE id = ?',
      [failedCount, failedCount, maxFailed, lockMinutes, id]
    ),

  recordSuccessfulLogin: (id: number) =>
    execute('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = UTC_TIMESTAMP() WHERE id = ?', [id]),
};

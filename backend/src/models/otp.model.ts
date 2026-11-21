import { execute, one } from '../db';

export interface OtpRow {
  id: number;
  code_hash: string;
  attempts: number;
  expires_at: Date;
}

export const OtpModel = {
  invalidateOpenEmailOtps: (userId: number) =>
    execute(
      "UPDATE otp_verifications SET consumed_at = UTC_TIMESTAMP() WHERE user_id = ? AND channel = 'email' AND purpose = 'verify' AND consumed_at IS NULL",
      [userId]
    ),

  createEmailOtp: (userId: number, codeHash: string, ttlMinutes: number) =>
    execute(
      `INSERT INTO otp_verifications (user_id, channel, purpose, code_hash, expires_at)
       VALUES (?, 'email', 'verify', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE))`,
      [userId, codeHash, ttlMinutes]
    ),

  latestOpenEmailOtp: (userId: number) =>
    one<OtpRow>(
      `SELECT id, code_hash, attempts, expires_at FROM otp_verifications
        WHERE user_id = ? AND channel = 'email' AND purpose = 'verify' AND consumed_at IS NULL
        ORDER BY id DESC LIMIT 1`,
      [userId]
    ),

  incrementAttempts: (id: number) => execute('UPDATE otp_verifications SET attempts = attempts + 1 WHERE id = ?', [id]),
  consume: (id: number) => execute('UPDATE otp_verifications SET consumed_at = UTC_TIMESTAMP() WHERE id = ?', [id]),
};

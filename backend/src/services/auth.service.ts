import argon2 from 'argon2';
import { v4 as uuid } from 'uuid';
import { UserModel, type User } from '../models/user.model';
import { OtpModel } from '../models/otp.model';
import { hmac, safeEqualHex, otpCode } from '../utils/crypto';
import { ApiError, type ReqCtx } from '../utils/http';
import { createSession, revokeAllSessions } from './session.service';
import { sendOtpEmail, sendSecurityEmail } from './email.service';
import { audit } from './audit.service';

const OTP_TTL_MIN = 10;
const MAX_OTP_ATTEMPTS = 5;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

export const publicUser = (u: User) => ({
  id: u.public_id, email: u.email, fullName: u.full_name, role: u.role, status: u.status,
});

async function issueEmailOtp(user: Pick<User, 'id' | 'email' | 'full_name'>) {
  const code = otpCode();
  await OtpModel.invalidateOpenEmailOtps(user.id);
  await OtpModel.createEmailOtp(user.id, hmac(`${user.id}:${code}`), OTP_TTL_MIN);
  await sendOtpEmail(user.email, user.full_name, code);
}

// FR-CUS-01. Same response whether or not the email exists, so it can't be used to enumerate users.
export async function register(
  d: { fullName: string; email: string; mobile: string; password: string }, ctx: ReqCtx
) {
  if (await UserModel.existsByEmailOrMobile(d.email, d.mobile)) return;
  const passwordHash = await argon2.hash(d.password, { type: argon2.argon2id });
  const id = await UserModel.createCustomer({
    publicId: uuid(), email: d.email, mobile: d.mobile, passwordHash, fullName: d.fullName,
  });
  await issueEmailOtp({ id, email: d.email, full_name: d.fullName });
  await audit(ctx, { action: 'customer.register', entity: 'user', entityId: id, actor: { userId: id, role: 'customer' } });
}

// FR-CUS-02: verify email OTP, then issue first tokens bound to a new session.
export async function verifyOtp(email: string, code: string, ctx: ReqCtx) {
  const bad = new ApiError(400, 'Invalid or expired code', 'INVALID_OTP');
  const user = await UserModel.findByEmail(email);
  if (!user) throw bad;
  const otp = await OtpModel.latestOpenEmailOtp(user.id);
  if (!otp || new Date(otp.expires_at) <= new Date() || otp.attempts >= MAX_OTP_ATTEMPTS) throw bad;

  if (!safeEqualHex(hmac(`${user.id}:${code}`), otp.code_hash)) {
    await OtpModel.incrementAttempts(otp.id);
    throw bad;
  }
  await OtpModel.consume(otp.id);
  await UserModel.markEmailVerified(user.id);
  const fresh = (await UserModel.findById(user.id))!;
  const tokens = await createSession(fresh, ctx);
  await audit(ctx, {
    action: 'auth.email_verified', entity: 'user', entityId: user.id,
    actor: { userId: user.id, role: user.role, sid: tokens.sid },
  });
  return { user: fresh, tokens };
}

export async function resendOtp(email: string) {
  const user = await UserModel.findByEmail(email);
  if (user && !user.email_verified_at) await issueEmailOtp(user);
}

// Change password for a signed-in user (customers and staff). Other devices are signed out;
// the current session stays valid.
export async function changePassword(
  userId: number, sid: string, currentPassword: string, newPassword: string, ctx: ReqCtx
) {
  const user = await UserModel.findById(userId);
  if (!user) throw new ApiError(401, 'Invalid session', 'SESSION_REVOKED');

  if (!(await argon2.verify(user.password_hash, currentPassword))) {
    await audit(ctx, { action: 'auth.change_password_failed', entity: 'user', entityId: userId, actor: { userId, role: user.role, sid } });
    throw new ApiError(400, 'Current password is incorrect', 'INVALID_CURRENT_PASSWORD');
  }
  if (currentPassword === newPassword) {
    throw new ApiError(400, 'New password must be different from the current password', 'PASSWORD_REUSE');
  }

  const hash = await argon2.hash(newPassword, { type: argon2.argon2id });
  await UserModel.updatePassword(userId, hash);
  const revoked = await revokeAllSessions(userId, 'password_changed', sid);
  await audit(ctx, {
    action: 'auth.password_changed', entity: 'user', entityId: userId, after: { otherSessionsRevoked: revoked },
    actor: { userId, role: user.role, sid },
  });
  void sendSecurityEmail(user.email, user.full_name, 'Your account password was changed. Other devices have been signed out.');
  return { revoked };
}

// FR-CUS-03 / FR-ADM-01 (same flow for customers and staff)
export async function login(email: string, password: string, ctx: ReqCtx) {
  const invalid = new ApiError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
  const user = await UserModel.findByEmail(email);
  if (!user) {
    await argon2.hash(password).catch(() => undefined); // equalise timing
    throw invalid;
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw new ApiError(429, 'Account temporarily locked due to failed attempts. Try again later.', 'ACCOUNT_LOCKED');
  }
  if (!(await argon2.verify(user.password_hash, password))) {
    await UserModel.recordFailedLogin(user.id, user.failed_login_count + 1, MAX_FAILED_LOGINS, LOCK_MINUTES);
    await audit(ctx, { action: 'auth.login_failed', entity: 'user', entityId: user.id, actor: { userId: user.id, role: user.role } });
    throw invalid;
  }
  if (!user.email_verified_at) throw new ApiError(403, 'Please verify your email first', 'EMAIL_NOT_VERIFIED');
  if (['suspended', 'closed'].includes(user.status)) throw new ApiError(403, 'Account is not allowed to sign in', 'ACCOUNT_BLOCKED');

  await UserModel.recordSuccessfulLogin(user.id);
  const tokens = await createSession(user, ctx);
  await audit(ctx, { action: 'auth.login', entity: 'user', entityId: user.id, actor: { userId: user.id, role: user.role, sid: tokens.sid } });
  void sendSecurityEmail(user.email, user.full_name, `A new sign-in to your account was detected (${ctx.maskedIp || 'unknown IP'}).`);
  return { user, tokens };
}

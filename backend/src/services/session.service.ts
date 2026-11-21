import { v4 as uuid } from 'uuid';
import config from '../config';
import { SessionModel } from '../models/session.model';
import type { Role, User } from '../models/user.model';
import { hmac, safeEqualHex, randomToken } from '../utils/crypto';
import { ApiError, parseUserAgent, type ReqCtx } from '../utils/http';
import { signAccessToken } from './token.service';

const refreshExpiry = () => new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

// Refresh token = "<sid>.<secret>"; only HMAC(secret) is stored, lookup is by sid (primary key).
const buildRefreshToken = (sid: string) => {
  const secret = randomToken(48);
  return { token: `${sid}.${secret}`, hash: hmac(secret) };
};

export interface Tokens {
  sid: string;
  accessToken: string;
  refreshToken: string;
}

/** Creates a session row + first access/refresh token pair (FR-CUS-02/03/05). */
export async function createSession(user: Pick<User, 'id' | 'role'>, ctx: ReqCtx): Promise<Tokens> {
  const sid = uuid();
  const { token: refreshToken, hash } = buildRefreshToken(sid);
  const { browser, os, deviceName } = parseUserAgent(ctx.userAgent);

  // Enforce max concurrent sessions: revoke the oldest ones beyond the limit.
  const active = await SessionModel.activeIdsOldestFirst(user.id);
  const overflow = active.length - (config.MAX_ACTIVE_SESSIONS - 1);
  if (overflow > 0) await SessionModel.revokeMany(active.slice(0, overflow), 'max_sessions_exceeded');

  await SessionModel.insert({
    id: sid, userId: user.id, refreshHash: hash, familyId: uuid(), deviceName, browser, os,
    ip: ctx.maskedIp, userAgent: ctx.userAgent, expiresAt: refreshExpiry(),
  });

  const { token: accessToken } = signAccessToken({ userId: user.id, sessionId: sid, role: user.role });
  return { sid, accessToken, refreshToken };
}

/** Validates + rotates a refresh token (FR-CUS-04). Detects reuse of an already-rotated token. */
export async function rotateRefreshToken(rawToken: unknown) {
  const [sid, secret] = String(rawToken || '').split('.');
  if (!sid || !secret) throw new ApiError(401, 'Invalid refresh token', 'INVALID_REFRESH');

  const s = await SessionModel.findWithUser(sid);
  if (!s || !s.is_active || new Date(s.expires_at) <= new Date()) {
    throw new ApiError(401, 'Session expired or revoked', 'SESSION_REVOKED');
  }
  if (['suspended', 'closed'].includes(s.status)) {
    throw new ApiError(403, 'Account is not allowed to sign in', 'ACCOUNT_BLOCKED');
  }

  const presented = hmac(secret);
  if (safeEqualHex(presented, s.prev_refresh_token_hash)) {
    // An old token was replayed => assume theft; kill the whole session.
    await SessionModel.revokeOne(s.id, s.user_id, 'refresh_reuse_detected');
    const err = new ApiError(401, 'Refresh token reuse detected. Session revoked.', 'REFRESH_REUSE');
    err.alertUser = { email: s.email, name: s.full_name };
    throw err;
  }
  if (!safeEqualHex(presented, s.refresh_token_hash)) throw new ApiError(401, 'Invalid refresh token', 'INVALID_REFRESH');

  const { token: refreshToken, hash } = buildRefreshToken(s.id);
  if (!(await SessionModel.rotate(s.id, presented, hash))) {
    throw new ApiError(401, 'Refresh token already used', 'INVALID_REFRESH');
  }
  const { token: accessToken } = signAccessToken({ userId: s.user_id, sessionId: s.id, role: s.role as Role });
  return { accessToken, refreshToken };
}

/** Revoke one session (FR-CUS-06); optionally denylist the current access token's jti. */
export async function revokeSession(
  sid: string, userId: number, reason: string, deny?: { jti: string; exp: number }
): Promise<boolean> {
  const ok = await SessionModel.revokeOne(sid, userId, reason);
  if (deny) await SessionModel.denylistJti(deny.jti, sid, userId, deny.exp);
  return ok;
}

export const revokeAllSessions = (userId: number, reason: string, exceptSid: string | null = null) =>
  SessionModel.revokeAllForUser(userId, reason, exceptSid);

export async function listActiveSessions(userId: number, currentSid: string | null) {
  const rows = await SessionModel.listActive(userId);
  return rows.map((r) => ({
    id: r.id,
    deviceName: r.device_name,
    browser: r.browser,
    os: r.os,
    ip: r.ip_address,
    loginAt: r.created_at,
    lastActiveAt: r.last_active_at,
    expiresAt: r.expires_at,
    current: r.id === currentSid,
  }));
}

export const cleanupExpired = () => SessionModel.cleanupExpired();

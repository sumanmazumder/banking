import type { NextFunction, Request, Response } from 'express';
import { SessionModel } from '../models/session.model';
import { verifyAccessToken, type AccessClaims } from '../services/token.service';
import { ApiError } from '../utils/http';

// Verifies the JWT, the jti denylist and that the bound session is still active - on EVERY request (SRS 10).
export const authenticate = async (req: Request, _res: Response, next: NextFunction) => {
  const m = (req.get('authorization') || '').match(/^Bearer (.+)$/i);
  if (!m) throw new ApiError(401, 'Missing access token', 'NO_TOKEN');

  let claims: AccessClaims;
  try {
    claims = verifyAccessToken(m[1]);
  } catch (err) {
    const expired = (err as Error).name === 'TokenExpiredError';
    throw new ApiError(401, expired ? 'Access token expired' : 'Invalid access token', expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN');
  }

  const userId = Number(claims.sub);
  const [denied, s] = await Promise.all([SessionModel.isJtiDenied(claims.jti), SessionModel.findForAuth(claims.sid, userId)]);
  if (denied || !s || !s.is_active || new Date(s.expires_at) <= new Date()) {
    throw new ApiError(401, 'Session has been revoked', 'SESSION_REVOKED');
  }
  if (['suspended', 'closed'].includes(s.status)) throw new ApiError(403, 'Account is not allowed to access', 'ACCOUNT_BLOCKED');

  req.auth = { userId, sid: claims.sid, jti: claims.jti, exp: claims.exp, role: s.role, status: s.status };

  // Touch last_active_at at most once a minute.
  if (Date.now() - new Date(s.last_active_at).getTime() > 60_000) SessionModel.touch(claims.sid).catch(() => undefined);
  next();
};

export const requireRole = (...roles: string[]) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth || !roles.includes(req.auth.role)) throw new ApiError(403, 'Insufficient permissions', 'FORBIDDEN');
  next();
};

export const STAFF_ROLES = ['super_admin', 'admin', 'finance_officer', 'auditor'];

// FR-CUS-06 / FR-CUS-09: money movement and loans are blocked until the account is approved and active.
export const requireActive = (req: Request, _res: Response, next: NextFunction) => {
  if (req.auth!.status !== 'active') throw new ApiError(403, 'Your account must be active to use this feature', 'ACCOUNT_NOT_ACTIVE');
  next();
};

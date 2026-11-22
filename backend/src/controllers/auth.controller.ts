import type { Request, Response } from 'express';
import config from '../config';
import { UserModel } from '../models/user.model';
import * as authService from '../services/auth.service';
import { audit } from '../services/audit.service';
import { sendSecurityEmail } from '../services/email.service';
import { revokeAllSessions, revokeSession, rotateRefreshToken, type Tokens } from '../services/session.service';
import { SessionModel } from '../models/session.model';
import { ApiError, REFRESH_COOKIE, clearCookieOptions, refreshCookieOptions, reqCtx } from '../utils/http';
import type { User } from '../models/user.model';

const sendSession = (res: Response, user: User, t: Tokens) => {
  res.cookie(REFRESH_COOKIE, t.refreshToken, refreshCookieOptions());
  res.json({ accessToken: t.accessToken, expiresIn: config.ACCESS_TOKEN_TTL, user: authService.publicUser(user) });
};

export const register = async (req: Request, res: Response) => {
  await authService.register(req.body, reqCtx(req));
  res.status(202).json({ message: 'If the details are valid, a verification code has been sent to the email address.' });
};

export const verifyOtp = async (req: Request, res: Response) => {
  const { user, tokens } = await authService.verifyOtp(req.body.email, req.body.code, reqCtx(req));
  sendSession(res, user, tokens);
};

export const resendOtp = async (req: Request, res: Response) => {
  await authService.resendOtp(req.body.email);
  res.json({ message: 'If the account exists and is unverified, a new code has been sent.' });
};

export const login = async (req: Request, res: Response) => {
  const { user, tokens } = await authService.login(req.body.email, req.body.password, reqCtx(req));
  sendSession(res, user, tokens);
};

export const refresh = async (req: Request, res: Response) => {
  try {
    const out = await rotateRefreshToken(req.cookies?.[REFRESH_COOKIE]);
    res.cookie(REFRESH_COOKIE, out.refreshToken, refreshCookieOptions());
    res.json({ accessToken: out.accessToken, expiresIn: config.ACCESS_TOKEN_TTL });
  } catch (err) {
    res.clearCookie(REFRESH_COOKIE, clearCookieOptions());
    const alert = (err as ApiError).alertUser;
    if (alert) void sendSecurityEmail(alert.email, alert.name, 'We detected reuse of an old session token and signed that session out for your safety.');
    throw err;
  }
};

export const logout = async (req: Request, res: Response) => {
  const { sid, userId, jti, exp } = req.auth!;
  await revokeSession(sid, userId, 'user_logout', { jti, exp });
  await audit(reqCtx(req), { action: 'auth.logout', entity: 'session', entityId: sid, actor: req.auth });
  res.clearCookie(REFRESH_COOKIE, clearCookieOptions());
  res.json({ message: 'Logged out' });
};

export const logoutAll = async (req: Request, res: Response) => {
  const { sid, userId, jti, exp } = req.auth!;
  const revoked = await revokeAllSessions(userId, 'user_logout_all');
  await SessionModel.denylistJti(jti, sid, userId, exp);
  await audit(reqCtx(req), { action: 'auth.logout_all', entity: 'user', entityId: userId, after: { revoked }, actor: req.auth });
  res.clearCookie(REFRESH_COOKIE, clearCookieOptions());
  res.json({ message: 'Logged out from all devices', revoked });
};

export const changePassword = async (req: Request, res: Response) => {
  const { userId, sid } = req.auth!;
  const { revoked } = await authService.changePassword(
    userId, sid, req.body.currentPassword, req.body.newPassword, reqCtx(req)
  );
  res.json({ message: 'Password changed successfully', otherSessionsRevoked: revoked });
};

export const me =async (req: Request, res: Response) => {
  const u = (await UserModel.findById(req.auth!.userId))!;
  res.json({
    id: u.public_id, email: u.email, mobile: u.mobile, fullName: u.full_name,
    role: u.role, status: u.status, createdAt: u.created_at, sid: req.auth!.sid,
  });
};

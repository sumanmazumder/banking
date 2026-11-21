import type { Request, Response } from 'express';
import { UserModel } from '../models/user.model';
import { audit } from '../services/audit.service';
import { sendSecurityEmail } from '../services/email.service';
import { listActiveSessions, revokeAllSessions, revokeSession } from '../services/session.service';
import { ApiError, reqCtx } from '../utils/http';

export const list = async (req: Request, res: Response) => {
  res.json({ sessions: await listActiveSessions(req.auth!.userId, req.auth!.sid) });
};

// Log out one specific session. If it's the current one, its jti is denylisted too.
export const revokeOne = async (req: Request, res: Response) => {
  const sid = String(req.params.sid);
  const { userId } = req.auth!;
  const isCurrent = sid === req.auth!.sid;
  const ok = await revokeSession(sid, userId, isCurrent ? 'user_logout' : 'user_remote_logout', isCurrent ? req.auth : undefined);
  if (!ok) throw new ApiError(404, 'Active session not found', 'NOT_FOUND');
  await audit(reqCtx(req), {
    action: 'session.revoke', entity: 'session', entityId: sid, reason: isCurrent ? 'self' : 'remote', actor: req.auth,
  });
  if (!isCurrent) {
    const u = await UserModel.findById(userId);
    if (u) void sendSecurityEmail(u.email, u.full_name, 'One of your active sessions was signed out remotely.');
  }
  res.json({ message: 'Session logged out', current: isCurrent });
};

export const logoutOthers = async (req: Request, res: Response) => {
  const revoked = await revokeAllSessions(req.auth!.userId, 'user_logout_others', req.auth!.sid);
  await audit(reqCtx(req), { action: 'session.revoke_others', entity: 'user', entityId: req.auth!.userId, after: { revoked }, actor: req.auth });
  res.json({ message: 'Other sessions logged out', revoked });
};

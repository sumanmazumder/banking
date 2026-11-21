import type { Request, Response } from 'express';
import { SessionModel } from '../models/session.model';
import { UserModel } from '../models/user.model';
import { audit } from '../services/audit.service';
import { listActiveSessions, revokeAllSessions, revokeSession } from '../services/session.service';
import { ApiError, reqCtx } from '../utils/http';

// Only a super admin may touch staff sessions; plain admins are limited to customers.
const assertCanRevoke = (req: Request, targetRole: string) => {
  if (targetRole !== 'customer' && req.auth!.role !== 'super_admin') {
    throw new ApiError(403, 'Only a super admin can revoke staff sessions', 'FORBIDDEN');
  }
};

export const userSessions = async (req: Request, res: Response) => {
  const u = await UserModel.findByPublicId(String(req.params.publicId));
  if (!u) throw new ApiError(404, 'User not found', 'NOT_FOUND');
  res.json({ sessions: await listActiveSessions(u.id, null) });
};

export const revokeAllForUser = async (req: Request, res: Response) => {
  const u = await UserModel.findByPublicId(String(req.params.publicId));
  if (!u) throw new ApiError(404, 'User not found', 'NOT_FOUND');
  assertCanRevoke(req, u.role);
  const revoked = await revokeAllSessions(u.id, 'admin_force_logout');
  await audit(reqCtx(req), {
    action: 'admin.session.revoke_all', entity: 'user', entityId: u.id, after: { revoked }, reason: req.body.reason, actor: req.auth,
  });
  res.json({ message: 'All sessions revoked', revoked });
};

export const revokeSessionById = async (req: Request, res: Response) => {
  const s = await SessionModel.findOwner(String(req.params.sid));
  if (!s) throw new ApiError(404, 'Session not found', 'NOT_FOUND');
  assertCanRevoke(req, s.role);
  await revokeSession(s.id, s.user_id, 'admin_force_logout');
  await audit(reqCtx(req), { action: 'admin.session.revoke', entity: 'session', entityId: s.id, reason: req.body.reason, actor: req.auth });
  res.json({ message: 'Session revoked' });
};

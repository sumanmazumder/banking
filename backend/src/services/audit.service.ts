import { AuditModel } from '../models/audit.model';
import type { ReqCtx } from '../utils/http';

export interface Actor {
  userId?: number | null;
  role?: string | null;
  sid?: string | null;
}

export interface AuditInput {
  action: string;
  actor?: Actor;
  entity?: string;
  entityId?: string | number;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

/** Never lets an audit failure break the request, but surfaces it in the log. */
export async function audit(ctx: ReqCtx, a: AuditInput): Promise<void> {
  try {
    await AuditModel.insert({
      actorId: a.actor?.userId ?? null,
      actorRole: a.actor?.role ?? null,
      sessionId: a.actor?.sid ?? null,
      action: a.action,
      entity: a.entity ?? null,
      entityId: a.entityId != null ? String(a.entityId) : null,
      before: a.before,
      after: a.after,
      reason: a.reason ?? null,
      ip: ctx.maskedIp,
      userAgent: ctx.userAgent || null,
    });
  } catch (err) {
    console.error('AUDIT WRITE FAILED:', a.action, (err as Error).message);
  }
}

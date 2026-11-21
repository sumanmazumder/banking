import { execute } from '../db';

// Append-only: this model intentionally exposes INSERT only.
export interface AuditRecord {
  actorId: number | null;
  actorRole: string | null;
  sessionId: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
}

export const AuditModel = {
  insert: (a: AuditRecord) =>
    execute(
      `INSERT INTO audit_logs
        (actor_id, actor_role, session_id, action, entity, entity_id, before_json, after_json, reason, ip_address, user_agent)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        a.actorId, a.actorRole, a.sessionId, a.action, a.entity, a.entityId,
        a.before ? JSON.stringify(a.before) : null,
        a.after ? JSON.stringify(a.after) : null,
        a.reason, a.ip, a.userAgent,
      ]
    ),
};

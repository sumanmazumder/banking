import { v4 as uuid } from 'uuid';
import { db, withTx } from '../db';
import { ApiError, type ReqCtx } from '../utils/http';
import { audit } from './audit.service';
import { notify } from './notification.service';

export async function createTicket(userId: number, i: { category: string; subject: string; message: string }, ctx: ReqCtx) {
  const publicId = uuid();
  await withTx(async (tx) => {
    const r = await tx.execute('INSERT INTO support_tickets (public_id, user_id, category, subject) VALUES (?,?,?,?)', [publicId, userId, i.category, i.subject]);
    await tx.execute("INSERT INTO support_messages (ticket_id, author_id, author_role, body) VALUES (?,?,'customer',?)", [r.insertId, userId, i.message]);
  });
  await audit(ctx, { action: 'support.create', entity: 'ticket', entityId: publicId, actor: { userId, role: 'customer' } });
  return { id: publicId };
}

export const ticketsForUser = (userId: number) =>
  db.query('SELECT public_id AS id, category, subject, status, created_at AS createdAt, updated_at AS updatedAt FROM support_tickets WHERE user_id = ? ORDER BY id DESC', [userId]);

export const allTickets = (status?: string) =>
  db.query(
    `SELECT t.public_id AS id, t.category, t.subject, t.status, t.created_at AS createdAt, t.updated_at AS updatedAt, u.full_name AS customer
       FROM support_tickets t JOIN users u ON u.id = t.user_id ${status ? 'WHERE t.status = ?' : ''} ORDER BY t.updated_at DESC LIMIT 200`,
    status ? [status] : []
  );

/** `ownerId` set => customer view (must own the ticket); null => staff. */
export async function ticketDetail(publicId: string, ownerId: number | null) {
  const t = await db.one<any>(
    `SELECT t.id, t.public_id AS publicId, t.category, t.subject, t.status, t.created_at AS createdAt, u.full_name AS customer
       FROM support_tickets t JOIN users u ON u.id = t.user_id WHERE t.public_id = ? ${ownerId ? 'AND t.user_id = ?' : ''}`,
    ownerId ? [publicId, ownerId] : [publicId]
  );
  if (!t) throw new ApiError(404, 'Ticket not found', 'NOT_FOUND');
  const messages = await db.query(
    'SELECT m.author_role AS role, u.full_name AS author, m.body, m.created_at AS createdAt FROM support_messages m JOIN users u ON u.id = m.author_id WHERE m.ticket_id = ? ORDER BY m.id',
    [t.id]
  );
  return { id: t.publicId, category: t.category, subject: t.subject, status: t.status, createdAt: t.createdAt, customer: t.customer, messages };
}

export async function reply(publicId: string, author: { userId: number; role: string }, body: string, ctx: ReqCtx, ownerId: number | null) {
  const t = await db.one<any>('SELECT id, user_id, status FROM support_tickets WHERE public_id = ? ' + (ownerId ? 'AND user_id = ?' : ''), ownerId ? [publicId, ownerId] : [publicId]);
  if (!t) throw new ApiError(404, 'Ticket not found', 'NOT_FOUND');
  if (t.status === 'closed') throw new ApiError(409, 'This ticket is closed', 'TICKET_CLOSED');
  await db.execute('INSERT INTO support_messages (ticket_id, author_id, author_role, body) VALUES (?,?,?,?)', [t.id, author.userId, author.role, body]);
  await db.execute('UPDATE support_tickets SET status = ? WHERE id = ?', [ownerId ? 'open' : 'in_progress', t.id]);
  if (!ownerId) await notify(t.user_id, 'support.reply', 'Support replied to your request', body.slice(0, 300));
}

export async function setStatus(publicId: string, status: 'open' | 'in_progress' | 'resolved' | 'closed', staff: { userId: number; role: string; sid: string }, ctx: ReqCtx) {
  const r = await db.execute('UPDATE support_tickets SET status = ?, assigned_to = COALESCE(assigned_to, ?) WHERE public_id = ?', [status, staff.userId, publicId]);
  if (!r.affectedRows) throw new ApiError(404, 'Ticket not found', 'NOT_FOUND');
  await audit(ctx, { action: 'support.status', entity: 'ticket', entityId: publicId, after: { status }, actor: staff });
}

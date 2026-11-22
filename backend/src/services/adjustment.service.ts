import { db, withTx } from '../db';
import { ApiError, type ReqCtx } from '../utils/http';
import { fromPaise, toPaise } from '../utils/money';
import { todayBusiness } from '../utils/dates';
import { audit } from './audit.service';
import { post } from './ledger.service';
import { notify } from './notification.service';

type Staff = { userId: number; role: string; sid: string };

/** Maker step: request a balance adjustment or reversal. Nothing is posted until a different person approves. */
export async function requestAdjustment(
  i: { accountPublicId: string; kind: 'adjustment' | 'reversal'; direction?: 'debit' | 'credit'; amount?: string; targetTxnId?: number; reason: string },
  staff: Staff, ctx: ReqCtx
) {
  const acc = await db.one<any>('SELECT id FROM accounts WHERE public_id = ?', [i.accountPublicId]);
  if (!acc) throw new ApiError(404, 'Account not found', 'NOT_FOUND');
  if (i.kind === 'adjustment') {
    if (!i.direction || !i.amount || toPaise(i.amount) <= 0) throw new ApiError(400, 'Adjustment needs a direction and a positive amount', 'VALIDATION');
  } else {
    const t = await db.one<any>('SELECT id, reversal_of FROM ledger_transactions WHERE id = ? AND account_id = ? AND ledger = ?', [i.targetTxnId ?? 0, acc.id, 'savings']);
    if (!t) throw new ApiError(404, 'Ledger entry not found on this account', 'NOT_FOUND');
    if (t.reversal_of) throw new ApiError(409, 'A reversal cannot itself be reversed', 'VALIDATION');
    if (await db.one('SELECT id FROM ledger_transactions WHERE reversal_of = ?', [t.id])) throw new ApiError(409, 'Entry already reversed', 'ALREADY_REVERSED');
    if (await db.one("SELECT id FROM adjustment_requests WHERE target_txn_id = ? AND status = 'pending'", [t.id])) throw new ApiError(409, 'A reversal is already pending for this entry', 'DUPLICATE');
  }
  const r = await db.execute(
    'INSERT INTO adjustment_requests (account_id, kind, direction, amount, target_txn_id, reason, requested_by) VALUES (?,?,?,?,?,?,?)',
    [acc.id, i.kind, i.direction ?? null, i.amount ?? null, i.targetTxnId ?? null, i.reason, staff.userId]
  );
  await audit(ctx, { action: `adjustment.request.${i.kind}`, entity: 'adjustment_request', entityId: r.insertId, after: i, reason: i.reason, actor: staff });
  return { id: r.insertId };
}

/** Checker step: a DIFFERENT user approves (posts the ledger row) or rejects. */
export async function decideAdjustment(id: number, approve: boolean, note: string, staff: Staff, ctx: ReqCtx) {
  await withTx(async (tx) => {
    const r = await tx.one<any>('SELECT * FROM adjustment_requests WHERE id = ? FOR UPDATE', [id]);
    if (!r) throw new ApiError(404, 'Request not found', 'NOT_FOUND');
    if (r.status !== 'pending') throw new ApiError(409, 'Request already decided', 'ALREADY_DECIDED');
    if (r.requested_by === staff.userId) throw new ApiError(403, 'You cannot approve your own request (maker-checker)', 'MAKER_CHECKER');
    let ledgerId: number | null = null;
    if (approve) {
      const today = todayBusiness();
      const acc = await tx.one<any>('SELECT user_id FROM accounts WHERE id = ?', [r.account_id]);
      if (r.kind === 'adjustment') {
        ledgerId = await post(tx, {
          reference: `ADJ-${r.id}`, accountId: r.account_id, type: 'adjustment', direction: r.direction, amount: r.amount,
          postingDate: today, description: `Adjustment: ${r.reason}`.slice(0, 255), createdBy: staff.userId,
        });
      } else {
        const t = await tx.one<any>('SELECT * FROM ledger_transactions WHERE id = ? FOR UPDATE', [r.target_txn_id]);
        if (await tx.one('SELECT id FROM ledger_transactions WHERE reversal_of = ?', [t.id])) throw new ApiError(409, 'Entry already reversed', 'ALREADY_REVERSED');
        ledgerId = await post(tx, {
          reference: `REV-${t.id}`, accountId: t.account_id, type: 'reversal', direction: t.direction === 'credit' ? 'debit' : 'credit',
          amount: t.amount, postingDate: today, description: `Reversal of ${t.reference}: ${r.reason}`.slice(0, 255),
          reversalOf: t.id, dueId: t.due_id, paymentId: t.payment_id, createdBy: staff.userId,
        });
        // A reversed contribution re-opens the related due.
        if (t.tx_type === 'contribution' && t.due_id) {
          const due = await tx.one<any>('SELECT * FROM billing_dues WHERE id = ? FOR UPDATE', [t.due_id]);
          const paid = Math.max(0, toPaise(due.paid_amount) - toPaise(t.amount));
          const status = paid >= toPaise(due.due_amount) ? 'paid' : today > due.grace_end_date ? 'overdue' : paid > 0 ? 'partial' : 'pending';
          await tx.execute('UPDATE billing_dues SET paid_amount = ?, status = ? WHERE id = ?', [fromPaise(paid), status, due.id]);
          if (t.payment_id) await tx.execute("UPDATE payments SET status = 'reversed' WHERE id = ?", [t.payment_id]);
        }
      }
      await notify(acc.user_id, 'ledger.adjusted', 'Account entry corrected', 'A correction was posted to your account. See your passbook for details.', `adj:${r.id}`, tx);
    }
    await tx.execute(
      'UPDATE adjustment_requests SET status = ?, decided_by = ?, decided_at = UTC_TIMESTAMP(), decision_note = ?, ledger_txn_id = ? WHERE id = ?',
      [approve ? 'approved' : 'rejected', staff.userId, note, ledgerId, id]
    );
  });
  await audit(ctx, { action: `adjustment.${approve ? 'approve' : 'reject'}`, entity: 'adjustment_request', entityId: id, reason: note, actor: staff });
}

export const listAdjustments = (status?: string) =>
  db.query(
    `SELECT r.id, r.kind, r.direction, r.amount, r.target_txn_id AS targetTxnId, r.reason, r.status, r.decision_note AS decisionNote,
            r.created_at AS createdAt, r.decided_at AS decidedAt, a.account_number AS accountNumber, u.full_name AS customer,
            m.full_name AS requestedBy, c.full_name AS decidedBy
       FROM adjustment_requests r JOIN accounts a ON a.id = r.account_id JOIN users u ON u.id = a.user_id
       JOIN users m ON m.id = r.requested_by LEFT JOIN users c ON c.id = r.decided_by
      ${status ? 'WHERE r.status = ?' : ''} ORDER BY r.id DESC LIMIT 200`,
    status ? [status] : []
  );

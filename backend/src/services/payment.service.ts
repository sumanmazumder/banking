import crypto from 'crypto';
import { db, withTx, type Db } from '../db';
import { ApiError, type ReqCtx } from '../utils/http';
import { fromPaise, toPaise } from '../utils/money';
import { todayBusiness } from '../utils/dates';
import { audit } from './audit.service';
import { post } from './ledger.service';
import { notify } from './notification.service';
import { newCustomerNumber, newReference } from './account.service';

const receiptNo = () => `RCP-${todayBusiness().replace(/-/g, '')}-${crypto.randomInt(100000, 999999)}`;

/** Outstanding on a due (principal only; late fees are charged to the account ledger separately). */
export const dueOutstandingPaise = (due: { due_amount: string; paid_amount: string }) => toPaise(due.due_amount) - toPaise(due.paid_amount);

/**
 * Settle a pending payment exactly once (idempotent): marks it successful, posts ONE ledger entry, and applies the
 * business effect (account activation or due payment). Safe to call repeatedly - e.g. gateway webhook retries.
 */
export async function settlePayment(
  reference: string, opts: { gatewayRef?: string | null; actorId?: number | null; note?: string; channel?: 'gateway' | 'staff' },
  ctx: ReqCtx, actor?: { userId: number; role: string; sid?: string }
) {
  const result = await withTx(async (tx) => {
    const p = await tx.one<any>('SELECT * FROM payments WHERE reference = ? FOR UPDATE', [reference]);
    if (!p) throw new ApiError(404, 'Payment not found', 'NOT_FOUND');
    if (p.status === 'success') return { payment: p, already: true };
    if (p.status !== 'pending') throw new ApiError(409, `Payment is ${p.status} and cannot be settled`, 'PAYMENT_STATE');

    const today = todayBusiness();
    const receipt = receiptNo();
    await tx.execute(
      "UPDATE payments SET status = 'success', settled_at = UTC_TIMESTAMP(), receipt_no = ?, gateway_ref = COALESCE(?, gateway_ref), recorded_by = COALESCE(?, recorded_by), note = COALESCE(?, note) WHERE id = ?",
      [receipt, opts.gatewayRef ?? null, opts.actorId ?? null, opts.note ?? null, p.id]
    );

    if (p.purpose === 'opening_deposit') {
      const acc = await tx.one<any>('SELECT * FROM accounts WHERE id = ? FOR UPDATE', [p.account_id]);
      const prof = await tx.one<{ kyc_status: string; customer_number: string | null }>('SELECT kyc_status, customer_number FROM customer_profiles WHERE user_id = ? FOR UPDATE', [p.user_id]);
      if (!acc || acc.status !== 'pending') throw new ApiError(409, 'Account is not awaiting activation', 'ACCOUNT_STATE');
      if (prof?.kyc_status !== 'approved') throw new ApiError(409, 'KYC is not approved - cannot activate', 'KYC_REQUIRED');
      await tx.execute("UPDATE accounts SET status = 'active', activated_at = UTC_TIMESTAMP() WHERE id = ?", [acc.id]);
      await tx.execute("UPDATE users SET status = 'active' WHERE id = ?", [p.user_id]);
      if (!prof.customer_number) {
        for (let n = 0; n < 5; n++) {
          try {
            await tx.execute('UPDATE customer_profiles SET customer_number = ? WHERE user_id = ?', [newCustomerNumber(), p.user_id]);
            break;
          } catch (e) {
            if ((e as { code?: string }).code !== 'ER_DUP_ENTRY') throw e;
          }
        }
      }
      await post(tx, {
        reference: `PAYTX-${p.reference}`, accountId: acc.id, type: 'opening_deposit', direction: 'credit', amount: p.amount,
        postingDate: today, description: 'Opening deposit', paymentId: p.id, createdBy: opts.actorId ?? null,
      });
      await notify(p.user_id, 'account.activated', 'Account activated', `Payment ${receipt} received. Your account ${acc.account_number} is now active.`, `activated:${p.user_id}`, tx);
    } else if (p.purpose === 'monthly_contribution') {
      const due = await tx.one<any>('SELECT * FROM billing_dues WHERE id = ? FOR UPDATE', [p.due_id]);
      if (!due) throw new ApiError(404, 'Due not found', 'NOT_FOUND');
      if (toPaise(p.amount) > dueOutstandingPaise(due)) throw new ApiError(409, 'Payment exceeds the outstanding due', 'OVERPAYMENT');
      const paid = toPaise(due.paid_amount) + toPaise(p.amount);
      const status = paid >= toPaise(due.due_amount) ? 'paid' : today > due.grace_end_date ? 'overdue' : 'partial';
      await tx.execute('UPDATE billing_dues SET paid_amount = ?, status = ? WHERE id = ?', [fromPaise(paid), status, due.id]);
      await post(tx, {
        reference: `PAYTX-${p.reference}`, accountId: p.account_id, type: 'contribution', direction: 'credit', amount: p.amount,
        postingDate: today, description: `Monthly contribution ${due.period}`, paymentId: p.id, dueId: due.id, createdBy: opts.actorId ?? null,
      });
      await notify(p.user_id, 'contribution.receipt', 'Payment received', `Receipt ${receipt}: ₹${p.amount} received for ${due.period}.`, `receipt:${p.reference}`, tx);
    }
    return { payment: { ...p, receipt_no: receipt, status: 'success' }, already: false };
  });
  if (!result.already) {
    await audit(ctx, {
      action: 'payment.settled', entity: 'payment', entityId: result.payment.id,
      after: { reference, amount: result.payment.amount, channel: opts.channel ?? result.payment.channel }, actor,
    });
  }
  return { reference, receiptNo: result.payment.receipt_no, status: 'success', already: result.already };
}

export async function failPayment(reference: string, reason: string, ctx: ReqCtx, actor?: { userId: number; role: string; sid?: string }) {
  const r = await db.execute("UPDATE payments SET status = 'failed', note = ? WHERE reference = ? AND status = 'pending'", [reason.slice(0, 255), reference]);
  if (!r.affectedRows) throw new ApiError(409, 'Only pending payments can be marked failed', 'PAYMENT_STATE');
  const p = await db.one<any>('SELECT id, user_id FROM payments WHERE reference = ?', [reference]);
  await notify(p.user_id, 'payment.failed', 'Payment failed', 'A payment could not be completed. Please try again.', `payfail:${reference}`);
  await audit(ctx, { action: 'payment.failed', entity: 'payment', entityId: p.id, reason, actor });
}

/** Customer starts a payment for one of their dues (gateway checkout in production; simulated in this prototype). */
export async function startDuePayment(userId: number, dueId: number, amount: string | undefined, ctx: ReqCtx) {
  const out = await withTx(async (tx) => {
    const due = await tx.one<any>('SELECT * FROM billing_dues WHERE id = ? AND user_id = ? FOR UPDATE', [dueId, userId]);
    if (!due) throw new ApiError(404, 'Due not found', 'NOT_FOUND');
    const outstanding = dueOutstandingPaise(due);
    if (outstanding <= 0) throw new ApiError(409, 'This due is already paid', 'ALREADY_PAID');
    const pay = amount ? toPaise(amount) : outstanding;
    if (pay <= 0 || pay > outstanding) throw new ApiError(400, `Amount must be between ₹0.01 and ₹${fromPaise(outstanding)}`, 'VALIDATION');
    // Only one open payment per due so retries/double-clicks cannot pile up.
    await tx.execute("UPDATE payments SET status = 'failed', note = 'Superseded' WHERE due_id = ? AND status = 'pending'", [dueId]);
    const reference = newReference('PAY');
    await tx.execute(
      "INSERT INTO payments (reference, user_id, account_id, purpose, due_id, amount, channel) VALUES (?,?,?,'monthly_contribution',?,?,'gateway')",
      [reference, userId, due.account_id, dueId, fromPaise(pay)]
    );
    return { reference, amount: fromPaise(pay) };
  });
  await audit(ctx, { action: 'payment.initiated', entity: 'due', entityId: dueId, after: out, actor: { userId, role: 'customer' } });
  return out;
}

/** Authorised staff record an offline payment with evidence (FR-MON-06). Creates and settles in one step. */
export async function recordStaffPayment(
  staff: { userId: number; role: string; sid: string }, dueId: number, amount: string, evidence: string, ctx: ReqCtx
) {
  const due = await db.one<any>('SELECT * FROM billing_dues WHERE id = ?', [dueId]);
  if (!due) throw new ApiError(404, 'Due not found', 'NOT_FOUND');
  if (toPaise(amount) <= 0 || toPaise(amount) > dueOutstandingPaise(due)) {
    throw new ApiError(400, `Amount must be between ₹0.01 and ₹${fromPaise(dueOutstandingPaise(due))}`, 'VALIDATION');
  }
  const reference = newReference('STF');
  await db.execute(
    "INSERT INTO payments (reference, user_id, account_id, purpose, due_id, amount, channel, recorded_by, note) VALUES (?,?,?,'monthly_contribution',?,?,'staff',?,?)",
    [reference, due.user_id, due.account_id, dueId, amount, staff.userId, evidence.slice(0, 255)]
  );
  return settlePayment(reference, { actorId: staff.userId, note: evidence, channel: 'staff' }, ctx, staff);
}

export async function reconcilePayment(id: number, staff: { userId: number; role: string; sid: string }, ctx: ReqCtx) {
  const r = await db.execute("UPDATE payments SET recon_status = 'reconciled' WHERE id = ? AND status = 'success' AND recon_status = 'unreconciled'", [id]);
  if (!r.affectedRows) throw new ApiError(409, 'Only successful, unreconciled payments can be reconciled', 'PAYMENT_STATE');
  await audit(ctx, { action: 'payment.reconciled', entity: 'payment', entityId: id, actor: staff });
}

/** Verify a payment-provider webhook signature (HMAC-SHA256 of the RAW body with the shared secret). */
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const paymentsForUser = (userId: number, d: Db = db) =>
  d.query(
    `SELECT p.id, p.reference, p.purpose, p.amount, p.status, p.channel, p.receipt_no AS receiptNo, p.settled_at AS settledAt, p.created_at AS createdAt, p.note, d.period
       FROM payments p LEFT JOIN billing_dues d ON d.id = p.due_id WHERE p.user_id = ? ORDER BY p.id DESC LIMIT 100`,
    [userId]
  );

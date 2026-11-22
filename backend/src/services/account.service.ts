import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import { db, withTx, type Db } from '../db';
import { ApiError, type ReqCtx } from '../utils/http';
import { fromPaise, toPaise } from '../utils/money';
import { audit } from './audit.service';

const digits = (n: number) => Array.from({ length: n }, () => crypto.randomInt(0, 10)).join('');
// Random (non-sequential) public identifiers - never expose database IDs (FR-ACC-05).
export const newAccountNumber = () => `BMS${digits(12)}`;
export const newCustomerNumber = () => `C${digits(9)}`;
export const newReference = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}${digits(4)}`;

export const getProduct = (d: Db = db) => d.one<any>('SELECT * FROM products WHERE is_active = 1 ORDER BY id LIMIT 1');

export async function openingOptions() {
  const p = await getProduct();
  if (!p) throw new ApiError(503, 'No active product configured', 'NO_PRODUCT');
  const amounts: string[] = [];
  for (let a = toPaise(p.opening_min); a <= toPaise(p.opening_max); a += toPaise(p.opening_step)) amounts.push(fromPaise(a));
  return { productName: p.name, min: p.opening_min, max: p.opening_max, step: p.opening_step, amounts, monthlyMin: p.monthly_min, monthlyMax: p.monthly_max };
}

export const accountForUser = (userId: number, d: Db = db) =>
  d.one<any>(
    `SELECT a.id, a.public_id AS publicId, a.account_number AS accountNumber, a.status, a.opening_amount AS openingAmount,
            a.opened_at AS openedAt, a.activated_at AS activatedAt, a.currency, p.customer_number AS customerNumber
       FROM accounts a JOIN customer_profiles p ON p.user_id = a.user_id WHERE a.user_id = ?`,
    [userId]
  );

/** Customer picks an opening amount: creates the pending account + a pending payment request (FR-ACC-01/02). */
export async function startOpening(userId: number, amount: string, ctx: ReqCtx) {
  const p = await getProduct();
  if (!p) throw new ApiError(503, 'No active product configured', 'NO_PRODUCT');
  const a = toPaise(amount);
  const ok = a >= toPaise(p.opening_min) && a <= toPaise(p.opening_max) && (a - toPaise(p.opening_min)) % toPaise(p.opening_step) === 0;
  if (!ok) throw new ApiError(400, `Choose one of the approved amounts (₹${p.opening_min} to ₹${p.opening_max} in steps of ₹${p.opening_step})`, 'VALIDATION');

  const out = await withTx(async (tx) => {
    const prof = await tx.one<{ kyc_status: string }>('SELECT kyc_status FROM customer_profiles WHERE user_id = ? FOR UPDATE', [userId]);
    if (prof?.kyc_status !== 'approved') throw new ApiError(403, 'Your KYC must be approved before opening an account', 'KYC_REQUIRED');

    let acc = await tx.one<any>('SELECT id, status FROM accounts WHERE user_id = ? FOR UPDATE', [userId]);
    if (acc && acc.status !== 'pending') throw new ApiError(409, 'Your account is already open', 'ALREADY_OPEN');
    if (!acc) {
      const r = await tx.execute(
        'INSERT INTO accounts (public_id, user_id, product_id, account_number, opening_amount) VALUES (?,?,?,?,?)',
        [uuid(), userId, p.id, newAccountNumber(), fromPaise(a)]
      );
      acc = { id: r.insertId };
    } else {
      await tx.execute('UPDATE accounts SET opening_amount = ? WHERE id = ?', [fromPaise(a), acc.id]);
      await tx.execute(
        "UPDATE payments SET status = 'failed', note = 'Superseded by a new request' WHERE account_id = ? AND purpose = 'opening_deposit' AND status = 'pending'",
        [acc.id]
      );
    }
    const reference = newReference('PAY');
    await tx.execute(
      "INSERT INTO payments (reference, user_id, account_id, purpose, amount, channel) VALUES (?,?,?,'opening_deposit',?,'gateway')",
      [reference, userId, acc.id, fromPaise(a)]
    );
    return { reference, accountId: acc.id };
  });
  await audit(ctx, { action: 'account.opening_requested', entity: 'account', entityId: out.accountId, after: { amount: fromPaise(a), reference: out.reference }, actor: { userId, role: 'customer' } });
  return { reference: out.reference, amount: fromPaise(a) };
}

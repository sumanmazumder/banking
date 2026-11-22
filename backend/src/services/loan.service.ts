import { v4 as uuid } from 'uuid';
import crypto from 'crypto';
import { db, withTx, type Db } from '../db';
import { ApiError, type ReqCtx } from '../utils/http';
import { emiPaise, fromPaise, toPaise } from '../utils/money';
import { addDays, addMonths, daysBetween, todayBusiness } from '../utils/dates';
import { audit } from './audit.service';
import { getBool, getNumber } from './settings.service';
import { loanLedger, post, savingsBalancePaise } from './ledger.service';
import { notify } from './notification.service';
import { computeFeePaise, currentLateFeeRule } from './billing.service';

type Staff = { userId: number; role: string; sid: string };

const digits = (n: number) => Array.from({ length: n }, () => crypto.randomInt(0, 10)).join('');
const outstandingPaise = (s: any) => toPaise(s.total_due) - toPaise(s.principal_paid) - toPaise(s.interest_paid) - toPaise(s.fee_paid);

/* --------------------------------- eligibility --------------------------------- */

/** FR-LOAN-01/02: eligible N months after ACCOUNT ACTIVATION (the qualifying start event; configurable). */
export async function eligibility(userId: number) {
  const acc = await db.one<any>("SELECT id, status, activated_at FROM accounts WHERE user_id = ?", [userId]);
  const months = await getNumber('loan_eligibility_months');
  if (!acc || acc.status !== 'active' || !acc.activated_at) {
    return { eligible: false, reason: 'Your account must be active before you can apply for a loan.', requiredMonths: months, eligibleFrom: null };
  }
  const activated = new Date(acc.activated_at).toISOString().slice(0, 10);
  const eligibleFrom = addMonths(activated, months);
  const today = todayBusiness();
  if (today < eligibleFrom) {
    return { eligible: false, reason: `You can apply from ${eligibleFrom} (${months} months after account activation).`, requiredMonths: months, eligibleFrom };
  }
  const open = await db.one("SELECT id FROM loan_applications WHERE user_id = ? AND status IN ('submitted','more_info','approved','accepted')", [userId]);
  if (open) return { eligible: false, reason: 'You already have a loan application in progress.', requiredMonths: months, eligibleFrom };
  return { eligible: true, reason: null, requiredMonths: months, eligibleFrom };
}

export async function loanTerms() {
  return {
    minAmount: await getNumber('loan_min_amount'), maxAmount: await getNumber('loan_max_amount'),
    minTenure: await getNumber('loan_min_tenure'), maxTenure: await getNumber('loan_max_tenure'),
    defaultRate: await getNumber('loan_annual_rate'),
  };
}

/* ---------------------------------- application ---------------------------------- */

export async function applyForLoan(userId: number, i: { amount: string; purpose: string; tenureMonths: number; documentsNote?: string }, ctx: ReqCtx) {
  const el = await eligibility(userId);
  if (!el.eligible) throw new ApiError(403, el.reason ?? 'Not eligible', 'NOT_ELIGIBLE');
  const t = await loanTerms();
  const a = toPaise(i.amount);
  if (a < t.minAmount * 100 || a > t.maxAmount * 100) throw new ApiError(400, `Amount must be between ₹${t.minAmount} and ₹${t.maxAmount}`, 'VALIDATION');
  if (i.tenureMonths < t.minTenure || i.tenureMonths > t.maxTenure) throw new ApiError(400, `Tenure must be ${t.minTenure}-${t.maxTenure} months`, 'VALIDATION');
  const acc = await db.one<any>('SELECT id FROM accounts WHERE user_id = ?', [userId]);
  const publicId = uuid();
  await db.execute(
    'INSERT INTO loan_applications (public_id, user_id, account_id, requested_amount, purpose, tenure_months, documents_note) VALUES (?,?,?,?,?,?,?)',
    [publicId, userId, acc.id, fromPaise(a), i.purpose, i.tenureMonths, i.documentsNote ?? null]
  );
  await notify(userId, 'loan.submitted', 'Loan application submitted', `Your application for ₹${fromPaise(a)} was submitted and is awaiting review.`);
  await audit(ctx, { action: 'loan.apply', entity: 'loan_application', entityId: publicId, after: i, actor: { userId, role: 'customer' } });
  return { id: publicId };
}

const appSelect = `SELECT a.public_id AS id, a.requested_amount AS requestedAmount, a.purpose, a.tenure_months AS tenureMonths, a.status,
    a.approved_amount AS approvedAmount, a.approved_rate AS approvedRate, a.approved_tenure AS approvedTenure, a.first_due_date AS firstDueDate,
    a.admin_note AS adminNote, a.created_at AS createdAt, a.reviewed_at AS reviewedAt, a.documents_note AS documentsNote`;

export const applicationsForUser = (userId: number) =>
  db.query(`${appSelect} FROM loan_applications a WHERE a.user_id = ? ORDER BY a.id DESC`, [userId]);

export const applicationQueue = (status?: string) =>
  db.query(
    `${appSelect}, u.full_name AS customer, u.public_id AS customerId, ac.account_number AS accountNumber
       FROM loan_applications a JOIN users u ON u.id = a.user_id JOIN accounts ac ON ac.id = a.account_id
      ${status ? 'WHERE a.status = ?' : ''} ORDER BY a.id DESC LIMIT 200`,
    status ? [status] : []
  );

/** FR-LOAN-04/05: approve (with the loan terms), reject, or request more information - always with a recorded reason. */
export async function reviewApplication(
  publicId: string,
  d: { decision: 'approve' | 'reject' | 'more_info'; note: string; amount?: string; rate?: number; tenureMonths?: number; firstDueDate?: string },
  staff: Staff, ctx: ReqCtx
) {
  const today = todayBusiness();
  const t = await loanTerms();
  await withTx(async (tx) => {
    const a = await tx.one<any>('SELECT * FROM loan_applications WHERE public_id = ? FOR UPDATE', [publicId]);
    if (!a) throw new ApiError(404, 'Application not found', 'NOT_FOUND');
    if (!['submitted', 'more_info'].includes(a.status)) throw new ApiError(409, 'This application can no longer be reviewed', 'APP_STATE');
    if (d.decision === 'approve') {
      const amount = d.amount ?? a.requested_amount;
      const rate = d.rate ?? t.defaultRate;
      const tenure = d.tenureMonths ?? a.tenure_months;
      const first = d.firstDueDate ?? addMonths(today, 1);
      if (toPaise(amount) < t.minAmount * 100 || toPaise(amount) > t.maxAmount * 100) throw new ApiError(400, 'Approved amount is outside the allowed range', 'VALIDATION');
      if (tenure < t.minTenure || tenure > t.maxTenure) throw new ApiError(400, 'Approved tenure is outside the allowed range', 'VALIDATION');
      if (first <= today) throw new ApiError(400, 'First due date must be in the future', 'VALIDATION');
      await tx.execute(
        `UPDATE loan_applications SET status='approved', approved_amount=?, approved_rate=?, approved_tenure=?, first_due_date=?, admin_note=?, reviewed_by=?, reviewed_at=UTC_TIMESTAMP() WHERE id=?`,
        [amount, rate, tenure, first, d.note, staff.userId, a.id]
      );
      await notify(a.user_id, 'loan.approved', 'Loan approved - action needed', `Your loan of ₹${amount} was approved at ${rate}% p.a. for ${tenure} months. Please review and accept the terms in the app.`, undefined, tx);
    } else {
      const status = d.decision === 'reject' ? 'rejected' : 'more_info';
      await tx.execute('UPDATE loan_applications SET status=?, admin_note=?, reviewed_by=?, reviewed_at=UTC_TIMESTAMP() WHERE id=?', [status, d.note, staff.userId, a.id]);
      await notify(a.user_id, `loan.${status}`, status === 'rejected' ? 'Loan application rejected' : 'More information needed for your loan', d.note, undefined, tx);
    }
  });
  await audit(ctx, { action: `loan.review.${d.decision}`, entity: 'loan_application', entityId: publicId, after: d, reason: d.note, actor: staff });
}

/** FR-LOAN-06: the customer must accept the final terms before anything is disbursed. */
export async function respondToTerms(userId: number, publicId: string, accept: boolean, ctx: ReqCtx) {
  const r = await db.execute(
    `UPDATE loan_applications SET status = ?, accepted_at = IF(?, UTC_TIMESTAMP(), NULL) WHERE public_id = ? AND user_id = ? AND status = 'approved'`,
    [accept ? 'accepted' : 'cancelled', accept ? 1 : 0, publicId, userId]
  );
  if (!r.affectedRows) throw new ApiError(409, 'There are no approved terms to respond to', 'APP_STATE');
  await audit(ctx, { action: accept ? 'loan.terms_accepted' : 'loan.terms_declined', entity: 'loan_application', entityId: publicId, actor: { userId, role: 'customer' } });
}

/* ------------------------------ schedule + disbursement ------------------------------ */

export interface ScheduleRow { no: number; dueDate: string; principal: number; interest: number }

/** Reducing-balance amortisation in paise; the last instalment absorbs rounding so the balance ends at exactly 0. */
export function buildSchedule(principalPaise: number, annualRate: number, months: number, firstDue: string): { emi: number; rows: ScheduleRow[] } {
  const emi = emiPaise(principalPaise, annualRate, months);
  const r = annualRate / 12 / 100;
  let bal = principalPaise;
  const rows: ScheduleRow[] = [];
  for (let n = 1; n <= months; n++) {
    const interest = Math.round(bal * r);
    const principal = n === months ? bal : Math.min(bal, emi - interest);
    rows.push({ no: n, dueDate: addMonths(firstDue, n - 1), principal, interest });
    bal -= principal;
  }
  return { emi, rows };
}

/** Disburses an ACCEPTED application: creates the loan, its own schedule, and linked savings+loan ledger rows. */
export async function disburse(publicId: string, staff: Staff, ctx: ReqCtx) {
  const today = todayBusiness();
  const out = await withTx(async (tx) => {
    const a = await tx.one<any>('SELECT * FROM loan_applications WHERE public_id = ? FOR UPDATE', [publicId]);
    if (!a) throw new ApiError(404, 'Application not found', 'NOT_FOUND');
    if (a.status !== 'accepted') throw new ApiError(409, 'The customer has not accepted the approved terms yet', 'APP_STATE');
    if (a.first_due_date <= today) throw new ApiError(409, 'First due date has passed - re-approve the application with a new date', 'APP_STATE');
    const acc = await tx.one<any>("SELECT id, status FROM accounts WHERE id = ? FOR UPDATE", [a.account_id]);
    if (acc.status !== 'active') throw new ApiError(409, 'Customer account is not active', 'ACCOUNT_STATE');

    const principal = toPaise(a.approved_amount);
    const { emi, rows } = buildSchedule(principal, Number(a.approved_rate), a.approved_tenure, a.first_due_date);
    const loanNumber = `LN${digits(10)}`;
    const loanPublic = uuid();
    const r = await tx.execute(
      `INSERT INTO loans (public_id, loan_number, application_id, user_id, account_id, principal, annual_rate, tenure_months, emi_amount, first_due_date, disbursed_at, approved_by, disbursed_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(),?,?)`,
      [loanPublic, loanNumber, a.id, a.user_id, a.account_id, a.approved_amount, a.approved_rate, a.approved_tenure, fromPaise(emi), a.first_due_date, a.reviewed_by, staff.userId]
    );
    const loanId = r.insertId;
    for (const s of rows) {
      await tx.execute(
        'INSERT INTO loan_schedules (loan_id, installment_no, due_date, principal_due, interest_due, total_due) VALUES (?,?,?,?,?,?)',
        [loanId, s.no, s.dueDate, fromPaise(s.principal), fromPaise(s.interest), fromPaise(s.principal + s.interest)]
      );
    }
    const group = `DISB-${loanId}`;
    await post(tx, { reference: `${group}-S`, accountId: a.account_id, loanId, ledger: 'savings', type: 'loan_disbursement', direction: 'credit', amount: a.approved_amount, postingDate: today, description: `Loan ${loanNumber} disbursed`, groupRef: group, createdBy: staff.userId });
    await post(tx, { reference: `${group}-L`, accountId: a.account_id, loanId, ledger: 'loan', type: 'loan_disbursement', direction: 'debit', amount: a.approved_amount, postingDate: today, description: `Principal disbursed`, groupRef: group, createdBy: staff.userId });
    await tx.execute("UPDATE loan_applications SET status = 'disbursed' WHERE id = ?", [a.id]);
    await notify(a.user_id, 'loan.disbursed', 'Loan disbursed', `Loan ${loanNumber} of ₹${a.approved_amount} was credited to your account. First instalment ₹${fromPaise(emi)} is due on ${a.first_due_date}.`, undefined, tx);
    return { loanId, loanNumber, loanPublic };
  });
  await audit(ctx, { action: 'loan.disburse', entity: 'loan', entityId: out.loanNumber, after: { application: publicId }, actor: staff });
  return { id: out.loanPublic, loanNumber: out.loanNumber };
}

/* -------------------------------------- views -------------------------------------- */

const loanSummary = (l: any, sched: any[], today: string) => {
  const principalPaid = sched.reduce((a, s) => a + toPaise(s.principal_paid), 0);
  const interestOut = sched.reduce((a, s) => a + toPaise(s.interest_due) - toPaise(s.interest_paid), 0);
  const overdue = sched.filter((s) => s.status === 'overdue').reduce((a, s) => a + outstandingPaise(s), 0);
  const accrued = sched.filter((s) => s.due_date <= today).reduce((a, s) => a + toPaise(s.interest_due) - toPaise(s.interest_paid), 0);
  const next = sched.find((s) => s.status !== 'paid');
  return {
    id: l.public_id, loanNumber: l.loan_number, principal: l.principal, annualRate: l.annual_rate, method: l.method,
    tenureMonths: l.tenure_months, emi: l.emi_amount, firstDueDate: l.first_due_date, disbursedAt: l.disbursed_at, status: l.status,
    paidAmount: fromPaise(sched.reduce((a, s) => a + toPaise(s.principal_paid) + toPaise(s.interest_paid) + toPaise(s.fee_paid), 0)),
    outstandingPrincipal: fromPaise(toPaise(l.principal) - principalPaid),
    outstandingInterest: fromPaise(interestOut),
    accruedInterest: fromPaise(accrued),
    overdueAmount: fromPaise(overdue),
    nextDue: next ? { dueDate: next.due_date, amount: fromPaise(outstandingPaise(next)), status: next.status } : null,
  };
};

const scheduleOut = (s: any) => ({
  installmentNo: s.installment_no, dueDate: s.due_date, principalDue: s.principal_due, interestDue: s.interest_due, feeDue: s.fee_due,
  totalDue: s.total_due, paid: fromPaise(toPaise(s.principal_paid) + toPaise(s.interest_paid) + toPaise(s.fee_paid)),
  outstanding: fromPaise(outstandingPaise(s)), status: s.status,
});

export async function loansForUser(userId: number) {
  const today = todayBusiness();
  const loans = await db.query<any>('SELECT * FROM loans WHERE user_id = ? ORDER BY id DESC', [userId]);
  const out = [];
  for (const l of loans) out.push(loanSummary(l, await db.query('SELECT * FROM loan_schedules WHERE loan_id = ? ORDER BY installment_no', [l.id]), today));
  return out;
}

/** userId = the owner (customer view, enforced by the WHERE) or null for staff. FR-LOAN-07 / FR-ML-06. */
export async function loanDetail(publicId: string, userId: number | null) {
  const l = await db.one<any>(`SELECT l.*, u.full_name AS customer FROM loans l JOIN users u ON u.id = l.user_id WHERE l.public_id = ? ${userId ? 'AND l.user_id = ?' : ''}`, userId ? [publicId, userId] : [publicId]);
  if (!l) throw new ApiError(404, 'Loan not found', 'NOT_FOUND');
  const sched = await db.query<any>('SELECT * FROM loan_schedules WHERE loan_id = ? ORDER BY installment_no', [l.id]);
  const repayments = await db.query(
    `SELECT r.created_at AS createdAt, r.amount, r.fee_part AS feePart, r.interest_part AS interestPart, r.principal_part AS principalPart, r.source, s.installment_no AS installmentNo
       FROM loan_repayments r JOIN loan_schedules s ON s.id = r.schedule_id WHERE r.loan_id = ? ORDER BY r.id DESC`,
    [l.id]
  );
  const attempts = await db.query(
    `SELECT a.attempt_date AS date, a.attempt_no AS attemptNo, a.status, a.amount_due AS amountDue, a.amount_debited AS amountDebited, a.shortfall, s.installment_no AS installmentNo
       FROM repayment_attempts a JOIN loan_schedules s ON s.id = a.schedule_id WHERE a.loan_id = ? ORDER BY a.id DESC`,
    [l.id]
  );
  return {
    ...loanSummary(l, sched, todayBusiness()), customer: l.customer, schedule: sched.map(scheduleOut), repayments, attempts,
    ledger: await loanLedger(l.id),
  };
}

/** FR-ML-02: total due per date with the loan-wise breakdown preserved. */
export async function duesSummary(userId: number) {
  const rows = await db.query<any>(
    `SELECT s.*, l.loan_number FROM loan_schedules s JOIN loans l ON l.id = s.loan_id
      WHERE l.user_id = ? AND s.status <> 'paid' ORDER BY s.due_date, l.id`,
    [userId]
  );
  const byDate = new Map<string, any>();
  for (const s of rows) {
    const g = byDate.get(s.due_date) ?? { dueDate: s.due_date, total: 0, loans: [] as any[] };
    const o = outstandingPaise(s);
    g.total += o;
    g.loans.push({ loanNumber: s.loan_number, installmentNo: s.installment_no, amount: fromPaise(o), status: s.status });
    byDate.set(s.due_date, g);
  }
  return [...byDate.values()].map((g) => ({ ...g, total: fromPaise(g.total) }));
}

/* ---------------------------------- repayment core ---------------------------------- */

/**
 * Applies `amountPaise` to ONE instalment: fee -> interest -> principal. Posts a linked pair of ledger rows
 * (savings debit + loan credit) and an allocation record. Never allocates more than the outstanding (FR-ML-05).
 * Caller must hold the account lock and have verified the balance.
 */
async function allocateToSchedule(tx: Db, s: any, amountPaise: number, source: 'auto_debit' | 'manual', actorId: number | null, today: string): Promise<number> {
  const feeO = toPaise(s.fee_due) - toPaise(s.fee_paid);
  const intO = toPaise(s.interest_due) - toPaise(s.interest_paid);
  const prinO = toPaise(s.principal_due) - toPaise(s.principal_paid);
  let rem = Math.min(amountPaise, feeO + intO + prinO);
  const fee = Math.min(rem, feeO); rem -= fee;
  const interest = Math.min(rem, intO); rem -= interest;
  const principal = Math.min(rem, prinO);
  const total = fee + interest + principal;
  if (total <= 0) return 0;

  const paidAll = fee === feeO && interest === intO && principal === prinO;
  const status = paidAll ? 'paid' : s.due_date < today ? 'overdue' : 'partial';
  await tx.execute(
    'UPDATE loan_schedules SET fee_paid = fee_paid + ?, interest_paid = interest_paid + ?, principal_paid = principal_paid + ?, status = ? WHERE id = ?',
    [fromPaise(fee), fromPaise(interest), fromPaise(principal), status, s.id]
  );
  const group = `LR-${uuid()}`;
  await tx.execute(
    'INSERT INTO loan_repayments (loan_id, schedule_id, amount, fee_part, interest_part, principal_part, source, group_ref, created_by) VALUES (?,?,?,?,?,?,?,?,?)',
    [s.loan_id, s.id, fromPaise(total), fromPaise(fee), fromPaise(interest), fromPaise(principal), source, group, actorId]
  );
  const accountId = (await tx.one<any>('SELECT account_id FROM loans WHERE id = ?', [s.loan_id]))!.account_id;
  const desc = `Loan repayment - instalment ${s.installment_no}`;
  await post(tx, { reference: `${group}-S`, accountId, loanId: s.loan_id, ledger: 'savings', type: 'loan_repayment', direction: 'debit', amount: fromPaise(total), postingDate: today, description: desc, groupRef: group, createdBy: actorId });
  await post(tx, { reference: `${group}-L`, accountId, loanId: s.loan_id, ledger: 'loan', type: 'loan_repayment', direction: 'credit', amount: fromPaise(total), postingDate: today, description: desc, groupRef: group, createdBy: actorId });
  return total;
}

async function closeIfSettled(tx: Db, loanId: number) {
  const open = await tx.one("SELECT id FROM loan_schedules WHERE loan_id = ? AND status <> 'paid' LIMIT 1", [loanId]);
  if (!open) await tx.execute("UPDATE loans SET status = 'closed' WHERE id = ?", [loanId]);
}

/** Customer repays a chosen loan from their savings balance (book transfer). Oldest instalments first (FR-ML-03). */
export async function manualRepay(userId: number, loanPublicId: string, amount: string, ctx: ReqCtx) {
  const today = todayBusiness();
  const a = toPaise(amount);
  if (a <= 0) throw new ApiError(400, 'Enter a valid amount', 'VALIDATION');
  const paid = await withTx(async (tx) => {
    const loan = await tx.one<any>("SELECT * FROM loans WHERE public_id = ? AND user_id = ? AND status = 'active'", [loanPublicId, userId]);
    if (!loan) throw new ApiError(404, 'Active loan not found', 'NOT_FOUND');
    await tx.one('SELECT id FROM accounts WHERE id = ? FOR UPDATE', [loan.account_id]);
    const balance = await savingsBalancePaise(tx, loan.account_id);
    if (a > balance) throw new ApiError(409, `Insufficient balance. Available: ₹${fromPaise(Math.max(0, balance))}`, 'INSUFFICIENT_FUNDS');
    const rows = await tx.query<any>("SELECT * FROM loan_schedules WHERE loan_id = ? AND status <> 'paid' ORDER BY installment_no FOR UPDATE", [loan.id]);
    const totalOut = rows.reduce((sum, s) => sum + outstandingPaise(s), 0);
    if (a > totalOut) throw new ApiError(400, `Amount exceeds the remaining loan dues (₹${fromPaise(totalOut)})`, 'VALIDATION');
    let rem = a;
    for (const s of rows) {
      if (rem <= 0) break;
      rem -= await allocateToSchedule(tx, s, rem, 'manual', userId, today);
    }
    await closeIfSettled(tx, loan.id);
    await notify(userId, 'loan.repayment', 'Repayment received', `₹${fromPaise(a)} was paid towards loan ${loan.loan_number}.`, undefined, tx);
    return a - rem;
  });
  await audit(ctx, { action: 'loan.repay_manual', entity: 'loan', entityId: loanPublicId, after: { amount: fromPaise(paid) }, actor: { userId, role: 'customer' } });
  return { paid: fromPaise(paid) };
}

/* ------------------------------------- mandates ------------------------------------- */

export const CONSENT_TEXT =
  'I authorise Banking Management System to debit the loan instalment amount due on each due date from my savings balance (an internal book transfer), ' +
  'and to retry on later days if funds are short, as per the loan terms. I can revoke this authorisation at any time.';

export const mandateForUser = (userId: number) =>
  db.one<any>(
    `SELECT mandate_ref AS mandateRef, status, consented_at AS consentedAt, valid_until AS validUntil, provider
       FROM repayment_mandates WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`,
    [userId]
  );

export async function createMandate(userId: number, validUntil: string | null, ctx: ReqCtx) {
  const acc = await db.one<any>("SELECT id FROM accounts WHERE user_id = ? AND status = 'active'", [userId]);
  if (!acc) throw new ApiError(403, 'An active account is required', 'ACCOUNT_STATE');
  if (validUntil && validUntil <= todayBusiness()) throw new ApiError(400, 'Valid-until date must be in the future', 'VALIDATION');
  const ref = `MND-${Date.now().toString(36).toUpperCase()}${digits(4)}`;
  await withTx(async (tx) => {
    await tx.execute("UPDATE repayment_mandates SET status = 'revoked', revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND status = 'active'", [userId]);
    await tx.execute(
      'INSERT INTO repayment_mandates (mandate_ref, user_id, account_id, consent_text, consent_ip, valid_until) VALUES (?,?,?,?,?,?)',
      [ref, userId, acc.id, CONSENT_TEXT, ctx.maskedIp, validUntil]
    );
  });
  await audit(ctx, { action: 'mandate.create', entity: 'mandate', entityId: ref, after: { validUntil }, actor: { userId, role: 'customer' } });
  return { mandateRef: ref };
}

export async function revokeMandate(userId: number, ctx: ReqCtx) {
  const r = await db.execute("UPDATE repayment_mandates SET status = 'revoked', revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND status = 'active'", [userId]);
  if (!r.affectedRows) throw new ApiError(404, 'No active mandate', 'NOT_FOUND');
  await audit(ctx, { action: 'mandate.revoke', entity: 'user', entityId: userId, actor: { userId, role: 'customer' } });
}

/* --------------------------------- scheduled jobs (idempotent) --------------------------------- */

export async function updateScheduleStatuses(today: string): Promise<number> {
  const r = await db.execute("UPDATE loan_schedules SET status = 'overdue' WHERE status IN ('upcoming','partial') AND due_date < ?", [today]);
  return r.affectedRows;
}

/** Adds a late fee to an overdue instalment once its grace period is over (fee_applied guards against repeats). */
export async function applyLoanLateFees(today: string): Promise<number> {
  const rule = await currentLateFeeRule(today);
  if (!rule) return 0;
  const grace = await getNumber('loan_grace_days');
  const rows = await db.query<any>("SELECT id FROM loan_schedules WHERE status = 'overdue' AND fee_applied = 0 AND due_date < ?", [addDays(today, -grace)]);
  let n = 0;
  for (const row of rows) {
    await withTx(async (tx) => {
      const s = await tx.one<any>("SELECT s.*, l.user_id, l.loan_number FROM loan_schedules s JOIN loans l ON l.id = s.loan_id WHERE s.id = ? FOR UPDATE", [row.id]);
      if (!s || s.fee_applied || s.status === 'paid') return;
      const fee = computeFeePaise(rule, outstandingPaise(s));
      await tx.execute('UPDATE loan_schedules SET fee_applied = 1, fee_due = ?, total_due = total_due + ? WHERE id = ?', [fromPaise(fee), fromPaise(fee), s.id]);
      if (fee > 0) {
        await notify(s.user_id, 'loan.latefee', 'Late fee on loan instalment', `A late fee of ₹${fromPaise(fee)} was added to instalment ${s.installment_no} of loan ${s.loan_number}.`, `loanfee:${s.id}`, tx);
        n++;
      }
    });
  }
  return n;
}

/** FR-AUTO-01/02: N days before a due date, compare available balance with what is due; email only if short. */
export async function advanceBalanceCheck(today: string): Promise<number> {
  const days = await getNumber('loan_reminder_days');
  const target = addDays(today, days);
  const groups = await db.query<any>(
    `SELECT l.user_id, l.account_id, SUM(CAST(s.total_due AS DECIMAL(14,2)) - s.principal_paid - s.interest_paid - s.fee_paid) AS due
       FROM loan_schedules s JOIN loans l ON l.id = s.loan_id
      WHERE s.due_date = ? AND s.status IN ('upcoming','partial') GROUP BY l.user_id, l.account_id`,
    [target]
  );
  let n = 0;
  for (const g of groups) {
    const balance = await savingsBalancePaise(db, g.account_id);
    const due = toPaise(g.due);
    if (balance >= due) continue; // sufficient - a forecast only, nothing is debited early
    const shortfall = due - Math.max(0, balance);
    await notify(g.user_id, 'loan.balance_warning', 'Loan instalment due soon - balance may be short',
      `Instalments totalling ₹${fromPaise(due)} are due on ${target}. Available balance: ₹${fromPaise(Math.max(0, balance))}. Shortfall: ₹${fromPaise(shortfall)}. Please add funds before the due date.`,
      `loan-check:${g.account_id}:${target}`);
    n++;
  }
  return n;
}

/**
 * FR-AUTO-03..07: on/after the due date, debit from the savings balance ONLY with an active mandate.
 * One locked transaction per account; UNIQUE(schedule, attempt_date) + the account row lock make re-runs harmless.
 * Allocation order across loans: earliest due date first, then oldest loan (documented waterfall, FR-AUTO-05).
 */
export async function runAutoRepayments(today: string): Promise<{ attempted: number; debited: number }> {
  const maxAttempts = await getNumber('repayment_max_attempts');
  const partialOk = await getBool('allow_partial_repayment');
  const accounts = await db.query<{ account_id: number }>(
    `SELECT DISTINCT l.account_id FROM loan_schedules s JOIN loans l ON l.id = s.loan_id
      WHERE s.due_date <= ? AND s.status IN ('upcoming','partial','overdue') AND l.status = 'active'`,
    [today]
  );
  let attempted = 0, debited = 0;
  for (const { account_id } of accounts) {
    await withTx(async (tx) => {
      const acc = await tx.one<any>('SELECT id, user_id FROM accounts WHERE id = ? FOR UPDATE', [account_id]);
      const mandate = await tx.one<any>(
        "SELECT id FROM repayment_mandates WHERE account_id = ? AND status = 'active' AND (valid_until IS NULL OR valid_until >= ?) LIMIT 1",
        [account_id, today]
      );
      const rows = await tx.query<any>(
        `SELECT s.*, l.loan_number, l.id AS lid,
                (SELECT COUNT(*) FROM repayment_attempts a WHERE a.schedule_id = s.id) AS tries,
                (SELECT COUNT(*) FROM repayment_attempts a WHERE a.schedule_id = s.id AND a.attempt_date = ?) AS today_tries
           FROM loan_schedules s JOIN loans l ON l.id = s.loan_id
          WHERE l.account_id = ? AND l.status = 'active' AND s.due_date <= ? AND s.status IN ('upcoming','partial','overdue')
          ORDER BY s.due_date, l.id, s.installment_no FOR UPDATE`,
        [today, account_id, today]
      );
      let bal = await savingsBalancePaise(tx, account_id);
      const touched = new Set<number>();
      for (const s of rows) {
        if (Number(s.today_tries) > 0 || Number(s.tries) >= maxAttempts) continue;
        const due = outstandingPaise(s);
        if (due <= 0) continue;
        attempted++;
        const attemptNo = Number(s.tries) + 1;
        let status: 'success' | 'partial' | 'failed_insufficient' | 'skipped_no_mandate';
        let take = 0;
        if (!mandate) status = 'skipped_no_mandate';
        else if (bal >= due) { take = due; status = 'success'; }
        else if (partialOk && bal > 0) { take = bal; status = 'partial'; }
        else status = 'failed_insufficient';

        if (take > 0) {
          const done = await allocateToSchedule(tx, s, take, 'auto_debit', null, today);
          bal -= done; take = done; debited++;
          touched.add(s.loan_id);
        }
        const shortfall = due - take;
        await tx.execute(
          'INSERT INTO repayment_attempts (schedule_id, loan_id, user_id, attempt_date, attempt_no, status, amount_due, amount_debited, shortfall) VALUES (?,?,?,?,?,?,?,?,?)',
          [s.id, s.loan_id, acc.user_id, today, attemptNo, status, fromPaise(due), fromPaise(take), fromPaise(shortfall)]
        );
        const key = `repay:${s.id}:${today}`;
        if (status === 'success') await notify(acc.user_id, 'loan.repay_success', 'Instalment paid', `Instalment ${s.installment_no} of loan ${s.loan_number} (₹${fromPaise(take)}) was paid automatically.`, key, tx);
        else if (status === 'skipped_no_mandate') await notify(acc.user_id, 'loan.repay_no_mandate', 'Instalment due - no auto-debit authorisation', `Instalment ${s.installment_no} of loan ${s.loan_number} (₹${fromPaise(due)}) is due. Please pay manually or set up auto-repayment.`, key, tx);
        else await notify(acc.user_id, 'loan.repay_failed', status === 'partial' ? 'Instalment partly paid' : 'Instalment payment failed',
          `Instalment ${s.installment_no} of loan ${s.loan_number}: debited ₹${fromPaise(take)} of ₹${fromPaise(due)}. Shortfall ₹${fromPaise(shortfall)}. We will retry (attempt ${attemptNo} of ${maxAttempts}).`, key, tx);
      }
      for (const id of touched) await closeIfSettled(tx, id);
    }).catch((e) => {
      if ((e as { code?: string }).code !== 'ER_DUP_ENTRY') throw e; // another runner already processed this account today
    });
  }
  return { attempted, debited };
}

export const daysLate = (due: string, today: string) => Math.max(0, daysBetween(due, today));

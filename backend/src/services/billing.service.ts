import { db, withTx, type Db } from '../db';
import { ApiError, type ReqCtx } from '../utils/http';
import { fromPaise, toPaise } from '../utils/money';
import { addDays, dateInPeriod, daysBetween, addMonthsToPeriod, periodOf, todayBusiness } from '../utils/dates';
import { audit } from './audit.service';
import { getNumber } from './settings.service';
import { post } from './ledger.service';
import { notify } from './notification.service';

type Staff = { userId: number; role: string; sid: string };

/* ---------------------------- contribution assignment ---------------------------- */

export interface AssignInput { amount: string; dueDay: number; graceDays: number; effectiveFrom: string }

/** FR-MON-01/02/05: assign or change the monthly amount. Changes only affect dues generated AFTER effectiveFrom. */
export async function assignContribution(accountPublicId: string, i: AssignInput, staff: Staff, ctx: ReqCtx) {
  const today = todayBusiness();
  if (i.effectiveFrom < today) throw new ApiError(400, 'Effective-from date cannot be in the past (existing dues stay unchanged)', 'VALIDATION');
  const out = await withTx(async (tx) => {
    const acc = await tx.one<any>('SELECT a.*, p.monthly_min, p.monthly_max FROM accounts a JOIN products p ON p.id = a.product_id WHERE a.public_id = ? FOR UPDATE', [accountPublicId]);
    if (!acc) throw new ApiError(404, 'Account not found', 'NOT_FOUND');
    if (acc.status !== 'active') throw new ApiError(409, 'Account must be active to assign a contribution', 'ACCOUNT_STATE');
    const a = toPaise(i.amount);
    if (a < toPaise(acc.monthly_min) || a > toPaise(acc.monthly_max)) {
      throw new ApiError(400, `Monthly amount must be between ₹${acc.monthly_min} and ₹${acc.monthly_max}`, 'VALIDATION');
    }
    const open = await tx.one<any>('SELECT * FROM contribution_assignments WHERE account_id = ? AND effective_to IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE', [acc.id]);
    if (open) {
      if (i.effectiveFrom <= open.effective_from) throw new ApiError(409, 'New effective date must be after the current assignment starts', 'VALIDATION');
      await tx.execute('UPDATE contribution_assignments SET effective_to = ? WHERE id = ?', [addDays(i.effectiveFrom, -1), open.id]);
    }
    const r = await tx.execute(
      'INSERT INTO contribution_assignments (user_id, account_id, amount, due_day, grace_days, effective_from, approved_by) VALUES (?,?,?,?,?,?,?)',
      [acc.user_id, acc.id, i.amount, i.dueDay, i.graceDays, i.effectiveFrom, staff.userId]
    );
    await notify(acc.user_id, 'contribution.assigned', 'Monthly contribution set', `Your monthly contribution is ₹${i.amount}, due on day ${i.dueDay} of each month from ${i.effectiveFrom}.`, undefined, tx);
    return { id: r.insertId, before: open ? { amount: open.amount, dueDay: open.due_day, graceDays: open.grace_days } : null, userId: acc.user_id };
  });
  await audit(ctx, { action: 'contribution.assign', entity: 'account', entityId: accountPublicId, before: out.before, after: i, actor: staff });
  await generateDues(today); // so the first due shows up immediately if it already falls in the current period
  return { id: out.id };
}

export const assignmentsForAccount = (accountId: number) =>
  db.query(
    `SELECT id, amount, due_day AS dueDay, grace_days AS graceDays, effective_from AS effectiveFrom, effective_to AS effectiveTo, created_at AS createdAt
       FROM contribution_assignments WHERE account_id = ? ORDER BY id DESC`,
    [accountId]
  );

/* --------------------------------- due generation -------------------------------- */

/**
 * Creates one due per account per period (UNIQUE key makes this idempotent - FR-MON-04). Catches up any missed
 * periods up to the current one. Each period uses the assignment in force on that period's due date.
 */
export async function generateDues(today: string): Promise<number> {
  const rows = await db.query<any>(
    `SELECT ca.* FROM contribution_assignments ca JOIN accounts a ON a.id = ca.account_id
      WHERE a.status = 'active' AND ca.effective_from <= ?`,
    [addDays(today, 31)]
  );
  const currentPeriod = periodOf(today);
  let created = 0;
  for (const ca of rows) {
    const lastPeriod = ca.effective_to ? (periodOf(ca.effective_to) < currentPeriod ? periodOf(ca.effective_to) : currentPeriod) : currentPeriod;
    for (let p = periodOf(ca.effective_from); p <= lastPeriod; p = addMonthsToPeriod(p, 1)) {
      const dueDate = dateInPeriod(p, ca.due_day);
      if (dueDate < ca.effective_from || (ca.effective_to && dueDate > ca.effective_to)) continue;
      const r = await db.execute(
        `INSERT IGNORE INTO billing_dues (user_id, account_id, assignment_id, period, due_amount, due_date, grace_end_date)
         VALUES (?,?,?,?,?,?,?)`,
        [ca.user_id, ca.account_id, ca.id, p, ca.amount, dueDate, addDays(dueDate, ca.grace_days)]
      );
      if (r.affectedRows) {
        created++;
        await notify(ca.user_id, 'contribution.due', `Contribution due ${p}`, `₹${ca.amount} is due on ${dueDate} (grace until ${addDays(dueDate, ca.grace_days)}).`, `due-created:${ca.account_id}:${p}`);
      }
    }
  }
  return created;
}

export async function refreshDueStatuses(today: string): Promise<number> {
  const r = await db.execute("UPDATE billing_dues SET status = 'overdue' WHERE status IN ('pending','partial') AND grace_end_date < ?", [today]);
  return r.affectedRows;
}

/** Reminders before the due date and when the grace period ends (FR-LATE-04). Deduped per due. */
export async function dueReminders(today: string): Promise<number> {
  const lead = await getNumber('due_reminder_days');
  const upcoming = await db.query<any>(
    "SELECT * FROM billing_dues WHERE status IN ('pending','partial') AND due_date = ?", [addDays(today, lead)]
  );
  for (const d of upcoming) {
    await notify(d.user_id, 'contribution.reminder', 'Contribution due soon', `₹${fromPaise(toPaise(d.due_amount) - toPaise(d.paid_amount))} is due on ${d.due_date}.`, `due-remind:${d.id}`);
  }
  const overdue = await db.query<any>("SELECT * FROM billing_dues WHERE status = 'overdue' AND grace_end_date = ?", [addDays(today, -1)]);
  for (const d of overdue) {
    await notify(d.user_id, 'contribution.overdue', 'Contribution overdue', `Your ${d.period} contribution is overdue. Outstanding: ₹${fromPaise(toPaise(d.due_amount) - toPaise(d.paid_amount))}.`, `due-overdue:${d.id}`);
  }
  return upcoming.length + overdue.length;
}

/* -------------------------------------- late fees -------------------------------------- */

export const currentLateFeeRule = (asOf: string, d: Db = db) =>
  d.one<any>('SELECT * FROM late_fee_rules WHERE effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1', [asOf]);

/** Fee for a base amount under a rule, in paise, capped (FR-LATE-01). */
export function computeFeePaise(rule: { fee_type: string; amount: string; cap_amount: string | null }, basePaise: number): number {
  let fee = rule.fee_type === 'fixed' ? toPaise(rule.amount) : Math.round((basePaise * Number(rule.amount)) / 100);
  if (rule.cap_amount != null) fee = Math.min(fee, toPaise(rule.cap_amount));
  return Math.max(0, fee);
}

/**
 * FR-LATE-02/06: assess a fee only once grace has ended, and only once per due (UNIQUE due_id).
 * The fee is charged to the account ledger as a separate 'late_fee' debit so it is shown separately (FR-LATE-03).
 */
export async function assessLateFees(today: string): Promise<number> {
  const rule = await currentLateFeeRule(today);
  if (!rule) return 0;
  const dues = await db.query<any>(
    `SELECT d.id FROM billing_dues d LEFT JOIN late_fee_assessments f ON f.due_id = d.id
      WHERE d.status = 'overdue' AND d.grace_end_date < ? AND f.id IS NULL`,
    [today]
  );
  let n = 0;
  for (const row of dues) {
    try {
      await withTx(async (tx) => {
        const d = await tx.one<any>('SELECT * FROM billing_dues WHERE id = ? FOR UPDATE', [row.id]);
        if (!d || d.status !== 'overdue') return;
        if (await tx.one('SELECT id FROM late_fee_assessments WHERE due_id = ?', [d.id])) return;
        const fee = computeFeePaise(rule, toPaise(d.due_amount) - toPaise(d.paid_amount));
        if (fee <= 0) return;
        const txnId = await post(tx, {
          reference: `LATEFEE-${d.id}`, accountId: d.account_id, type: 'late_fee', direction: 'debit', amount: fromPaise(fee),
          postingDate: today, description: `Late fee for ${d.period} contribution`, dueId: d.id,
        });
        await tx.execute('INSERT INTO late_fee_assessments (due_id, rule_id, amount, ledger_txn_id) VALUES (?,?,?,?)', [d.id, rule.id, fromPaise(fee), txnId]);
        await notify(d.user_id, 'latefee.applied', 'Late fee applied', `A late fee of ₹${fromPaise(fee)} was applied for your ${d.period} contribution.`, `latefee:${d.id}`, tx);
        n++;
      });
    } catch (e) {
      if ((e as { code?: string }).code !== 'ER_DUP_ENTRY') throw e; // a concurrent run already assessed it
    }
  }
  return n;
}

/** FR-LATE-05: waive only with permission and a mandatory reason; posts a linked reversal, never edits history. */
export async function waiveLateFee(dueId: number, reason: string, staff: Staff, ctx: ReqCtx) {
  const today = todayBusiness();
  await withTx(async (tx) => {
    const f = await tx.one<any>(
      `SELECT f.*, d.account_id, d.user_id, d.period FROM late_fee_assessments f JOIN billing_dues d ON d.id = f.due_id WHERE f.due_id = ? FOR UPDATE`,
      [dueId]
    );
    if (!f) throw new ApiError(404, 'No late fee on this due', 'NOT_FOUND');
    if (f.status === 'waived') throw new ApiError(409, 'Fee already waived', 'ALREADY_WAIVED');
    await post(tx, {
      reference: `LATEFEE-WAIVE-${f.due_id}`, accountId: f.account_id, type: 'reversal', direction: 'credit', amount: f.amount,
      postingDate: today, description: `Late fee waived (${f.period})`, dueId: f.due_id, reversalOf: f.ledger_txn_id, createdBy: staff.userId,
    });
    await tx.execute("UPDATE late_fee_assessments SET status = 'waived', waived_by = ?, waive_reason = ? WHERE id = ?", [staff.userId, reason, f.id]);
    await notify(f.user_id, 'latefee.waived', 'Late fee waived', `The late fee for ${f.period} has been waived.`, `latefee-waived:${f.due_id}`, tx);
  });
  await audit(ctx, { action: 'latefee.waive', entity: 'due', entityId: dueId, reason, actor: staff });
}

export async function createLateFeeRule(
  i: { feeType: 'fixed' | 'percent'; amount: string; capAmount: string | null; effectiveFrom: string }, staff: Staff, ctx: ReqCtx
) {
  const before = await currentLateFeeRule(todayBusiness());
  const r = await db.execute('INSERT INTO late_fee_rules (fee_type, amount, cap_amount, effective_from, created_by) VALUES (?,?,?,?,?)', [
    i.feeType, i.amount, i.capAmount, i.effectiveFrom, staff.userId,
  ]);
  await audit(ctx, { action: 'latefee.rule_create', entity: 'late_fee_rule', entityId: r.insertId, before, after: i, actor: staff });
  return { id: r.insertId };
}

/* ----------------------------------- customer views ----------------------------------- */

/** Dues with the amounts FR-LATE-03 asks to be shown separately. */
export async function duesForUser(userId: number) {
  const today = todayBusiness();
  const rows = await db.query<any>(
    `SELECT d.id, d.period, d.due_amount, d.paid_amount, d.due_date, d.grace_end_date, d.status,
            f.amount AS fee_amount, f.status AS fee_status
       FROM billing_dues d LEFT JOIN late_fee_assessments f ON f.due_id = d.id
      WHERE d.user_id = ? ORDER BY d.due_date DESC LIMIT 60`,
    [userId]
  );
  return rows.map((d) => ({
    id: d.id, period: d.period, dueAmount: d.due_amount, paidAmount: d.paid_amount,
    outstanding: fromPaise(toPaise(d.due_amount) - toPaise(d.paid_amount)),
    dueDate: d.due_date, graceEndDate: d.grace_end_date, status: d.status,
    daysOverdue: d.status === 'overdue' ? Math.max(0, daysBetween(d.due_date, today)) : 0,
    lateFee: d.fee_amount ? { amount: d.fee_amount, status: d.fee_status } : null,
  }));
}

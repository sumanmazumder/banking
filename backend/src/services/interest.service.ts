import { db, withTx } from '../db';
import { ApiError, type ReqCtx } from '../utils/http';
import { fromPaise, toPaise } from '../utils/money';
import { lastDayOfMonth, todayBusiness } from '../utils/dates';
import { audit } from './audit.service';
import { post, savingsBalancePaise } from './ledger.service';
import { notify } from './notification.service';

type Staff = { userId: number; role: string; sid: string };

// Borrowed money must not earn savings interest, so loan disbursements/repayments are excluded from the base.
const LOAN_TYPES: ('loan_disbursement' | 'loan_repayment')[] = ['loan_disbursement', 'loan_repayment'];

export interface RuleInput {
  ratePercent: string; ratePeriod: 'monthly' | 'annual'; compounding: 'simple' | 'compound'; minBalance: string;
  effectiveFrom: string; note?: string;
}

/** Monthly rate in percent, whichever period the rule was entered in. */
export const monthlyRatePct = (r: { rate_percent: string; rate_period: string }) =>
  r.rate_period === 'monthly' ? Number(r.rate_percent) : Number(r.rate_percent) / 12;

/** A rule starts as DRAFT: nothing is posted until a different super admin approves it (compliance gate, SRS 5.5). */
export async function createRule(i: RuleInput, staff: Staff, ctx: ReqCtx) {
  const r = await db.execute(
    'INSERT INTO interest_rules (rate_percent, rate_period, compounding, min_balance, effective_from, note, created_by) VALUES (?,?,?,?,?,?,?)',
    [i.ratePercent, i.ratePeriod, i.compounding, i.minBalance, i.effectiveFrom, i.note ?? null, staff.userId]
  );
  await audit(ctx, { action: 'interest.rule_create', entity: 'interest_rule', entityId: r.insertId, after: i, actor: staff });
  return { id: r.insertId };
}

export async function approveRule(id: number, staff: Staff, ctx: ReqCtx) {
  await withTx(async (tx) => {
    const r = await tx.one<any>('SELECT * FROM interest_rules WHERE id = ? FOR UPDATE', [id]);
    if (!r) throw new ApiError(404, 'Rule not found', 'NOT_FOUND');
    if (r.status !== 'draft') throw new ApiError(409, 'Only draft rules can be approved', 'RULE_STATE');
    if (r.created_by === staff.userId) throw new ApiError(403, 'A rule must be approved by a different super admin (maker-checker)', 'MAKER_CHECKER');
    await tx.execute("UPDATE interest_rules SET status = 'retired' WHERE status = 'active'");
    await tx.execute("UPDATE interest_rules SET status = 'active', approved_by = ?, approved_at = UTC_TIMESTAMP() WHERE id = ?", [staff.userId, id]);
  });
  await audit(ctx, { action: 'interest.rule_approve', entity: 'interest_rule', entityId: id, actor: staff });
}

export const listRules = () =>
  db.query(
    `SELECT r.id, r.rate_percent AS ratePercent, r.rate_period AS ratePeriod, r.compounding, r.min_balance AS minBalance,
            r.effective_from AS effectiveFrom, r.status, r.note, r.created_at AS createdAt,
            c.full_name AS createdBy, a.full_name AS approvedBy
       FROM interest_rules r LEFT JOIN users c ON c.id = r.created_by LEFT JOIN users a ON a.id = r.approved_by ORDER BY r.id DESC`
  );

const ruleForPeriod = (asOf: string) =>
  db.one<any>(
    `SELECT * FROM interest_rules WHERE status IN ('active','retired') AND approved_at IS NOT NULL AND effective_from <= ?
      ORDER BY effective_from DESC, id DESC LIMIT 1`,
    [asOf]
  );

/**
 * Posts interest for a COMPLETED month using the approved rule in force at month end (daily-close-balance basis:
 * the balance at month end). Idempotent: UNIQUE(account, period). Corrections are reversals, never edits.
 */
export async function postInterestForPeriod(period: string, ctx: ReqCtx, staff?: Staff) {
  const monthEnd = lastDayOfMonth(period);
  if (monthEnd >= todayBusiness()) throw new ApiError(409, 'Interest can only be posted after the month has ended', 'PERIOD_OPEN');
  const rule = await ruleForPeriod(monthEnd);
  if (!rule) return { posted: 0, skipped: 0, message: 'No approved interest rule is active for this period - nothing posted.' };

  const pct = monthlyRatePct(rule);
  const accounts = await db.query<any>("SELECT id, user_id FROM accounts WHERE status = 'active' AND activated_at <= ?", [`${monthEnd} 23:59:59`]);
  let posted = 0, skipped = 0;
  for (const a of accounts) {
    try {
      const did = await withTx(async (tx) => {
        await tx.one('SELECT id FROM accounts WHERE id = ? FOR UPDATE', [a.id]);
        if (await tx.one('SELECT id FROM interest_postings WHERE account_id = ? AND period = ?', [a.id, period])) return false;
        // simple: interest is not paid on earlier interest; compound: it is. Late fees reduce the balance either way.
        const base = await savingsBalancePaise(tx, a.id, monthEnd, rule.compounding === 'simple' ? ['interest_credit', ...LOAN_TYPES] : [...LOAN_TYPES]);
        if (base <= 0 || base < toPaise(rule.min_balance)) return false;
        const amount = Math.round((base * pct) / 100);
        if (amount <= 0) return false;
        const txnId = await post(tx, {
          reference: `INT-${a.id}-${period}`, accountId: a.id, type: 'interest_credit', direction: 'credit', amount: fromPaise(amount),
          postingDate: monthEnd, description: `Interest for ${period} @ ${pct.toFixed(4)}%/month`, createdBy: staff?.userId ?? null,
        });
        await tx.execute(
          'INSERT INTO interest_postings (account_id, rule_id, period, base_amount, monthly_rate, amount, ledger_txn_id) VALUES (?,?,?,?,?,?,?)',
          [a.id, rule.id, period, fromPaise(base), pct.toFixed(6), fromPaise(amount), txnId]
        );
        await notify(a.user_id, 'interest.posted', 'Interest credited', `Interest of ₹${fromPaise(amount)} for ${period} was credited to your account.`, `interest:${a.id}:${period}`, tx);
        return true;
      });
      did ? posted++ : skipped++;
    } catch (e) {
      if ((e as { code?: string }).code === 'ER_DUP_ENTRY') skipped++;
      else throw e;
    }
  }
  await audit(ctx, { action: 'interest.post', entity: 'period', entityId: period, after: { ruleId: rule.id, posted, skipped }, actor: staff });
  return { posted, skipped, message: `Posted interest to ${posted} account(s).` };
}

export const postingsForPeriod = (period: string) =>
  db.query(
    `SELECT ip.id, a.account_number AS accountNumber, u.full_name AS fullName, ip.base_amount AS baseAmount,
            ip.monthly_rate AS monthlyRate, ip.amount, ip.rule_id AS ruleId
       FROM interest_postings ip JOIN accounts a ON a.id = ip.account_id JOIN users u ON u.id = a.user_id
      WHERE ip.period = ? ORDER BY ip.id DESC LIMIT 500`,
    [period]
  );

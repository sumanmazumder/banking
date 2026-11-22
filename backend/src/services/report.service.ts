import { db } from '../db';
import { fromPaise, toPaise } from '../utils/money';
import { addDays, todayBusiness, periodOf } from '../utils/dates';

const n = (v: unknown) => Number(v ?? 0);
const m = (v: unknown) => fromPaise(toPaise(v as string));

/** Admin dashboard metrics (FR-ADM-03) + the SRS section 11 report headings, all derived from live data. */
export async function dashboardSummary() {
  const today = todayBusiness();
  const period = periodOf(today);
  const [c] = await db.query<any>(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE role = 'customer') AS totalCustomers,
      (SELECT COUNT(*) FROM kyc_records WHERE verification_status = 'pending') AS pendingKyc,
      (SELECT COUNT(*) FROM users WHERE role = 'customer' AND status = 'rejected') AS rejectedKyc,
      (SELECT COUNT(*) FROM accounts WHERE status = 'active') AS activeAccounts,
      (SELECT COUNT(*) FROM accounts WHERE status = 'pending') AS pendingAccounts,
      (SELECT COUNT(*) FROM user_sessions WHERE is_active = 1 AND expires_at > UTC_TIMESTAMP()) AS activeSessions`);
  const [d] = await db.query<any>(
    `SELECT
       COALESCE(SUM(CASE WHEN period = ? THEN due_amount END),0) AS dueThisPeriod,
       COALESCE(SUM(CASE WHEN period = ? THEN paid_amount END),0) AS collectedThisPeriod,
       COALESCE(SUM(CASE WHEN status IN ('pending','partial','overdue') THEN due_amount - paid_amount END),0) AS outstandingDues,
       COALESCE(SUM(CASE WHEN status = 'overdue' THEN due_amount - paid_amount END),0) AS overdueAmount,
       COUNT(DISTINCT CASE WHEN status = 'overdue' THEN account_id END) AS overdueAccounts,
       COUNT(CASE WHEN status IN ('pending','partial') AND due_date <= ? THEN 1 END) AS dueNow
     FROM billing_dues`,
    [period, period, addDays(today, 7)]
  );
  const [l] = await db.query<any>(`
    SELECT
      (SELECT COUNT(*) FROM loans WHERE status = 'active') AS activeLoans,
      (SELECT COUNT(*) FROM loan_applications WHERE status IN ('submitted','more_info')) AS pendingApplications,
      (SELECT COALESCE(SUM(principal_due - principal_paid),0) FROM loan_schedules s JOIN loans lo ON lo.id = s.loan_id WHERE lo.status = 'active') AS outstandingPrincipal,
      (SELECT COALESCE(SUM(total_due - principal_paid - interest_paid - fee_paid),0) FROM loan_schedules WHERE status = 'overdue') AS overdueLoanAmount,
      (SELECT COALESCE(SUM(total_due - principal_paid - interest_paid - fee_paid),0) FROM loan_schedules WHERE status IN ('upcoming','partial') AND due_date BETWEEN ? AND ?) AS upcomingInstalments`,
    [today, addDays(today, 7)]
  );
  const [x] = await db.query<any>(`
    SELECT
      (SELECT COUNT(*) FROM payments WHERE status = 'pending' AND created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)) AS stalePayments,
      (SELECT COUNT(*) FROM payments WHERE status = 'success' AND recon_status = 'unreconciled') AS unreconciled,
      (SELECT COUNT(*) FROM adjustment_requests WHERE status = 'pending') AS pendingAdjustments,
      (SELECT COUNT(*) FROM repayment_attempts WHERE attempt_date = ? AND status IN ('failed_insufficient','partial','skipped_no_mandate')) AS failedRepaymentsToday,
      (SELECT COUNT(*) FROM support_tickets WHERE status IN ('open','in_progress')) AS openTickets,
      (SELECT COUNT(*) FROM notifications WHERE delivery_status = 'failed') AS failedEmails,
      (SELECT COUNT(*) FROM job_runs WHERE status = 'error' AND started_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY)) AS recentJobErrors`, [today]);
  return {
    asOf: today,
    customers: { total: n(c.totalCustomers), pendingKyc: n(c.pendingKyc), rejectedKyc: n(c.rejectedKyc), activeAccounts: n(c.activeAccounts), pendingAccounts: n(c.pendingAccounts), activeSessions: n(c.activeSessions) },
    contributions: { dueThisPeriod: m(d.dueThisPeriod), collectedThisPeriod: m(d.collectedThisPeriod), outstanding: m(d.outstandingDues), overdueAmount: m(d.overdueAmount), overdueAccounts: n(d.overdueAccounts), dueWithin7Days: n(d.dueNow) },
    loans: { active: n(l.activeLoans), pendingApplications: n(l.pendingApplications), outstandingPrincipal: m(l.outstandingPrincipal), overdueAmount: m(l.overdueLoanAmount), upcomingInstalments7d: m(l.upcomingInstalments) },
    exceptions: { stalePayments: n(x.stalePayments), unreconciledPayments: n(x.unreconciled), pendingAdjustments: n(x.pendingAdjustments), failedRepaymentsToday: n(x.failedRepaymentsToday), openTickets: n(x.openTickets), failedEmails: n(x.failedEmails), recentJobErrors: n(x.recentJobErrors) },
  };
}

/** Daily collection report for a date range. */
export const collections = (from: string, to: string) =>
  db.query(
    `SELECT DATE(settled_at) AS date, purpose, channel, COUNT(*) AS count, SUM(amount) AS total
       FROM payments WHERE status = 'success' AND DATE(settled_at) BETWEEN ? AND ? GROUP BY DATE(settled_at), purpose, channel ORDER BY date DESC`,
    [from, to]
  );

export const lateFeeReport = (from: string, to: string) =>
  db.query(
    `SELECT f.status, COUNT(*) AS count, SUM(f.amount) AS total FROM late_fee_assessments f WHERE DATE(f.created_at) BETWEEN ? AND ? GROUP BY f.status`,
    [from, to]
  );

export const interestReport = () =>
  db.query(`SELECT period, COUNT(*) AS accounts, SUM(amount) AS total, SUM(base_amount) AS base FROM interest_postings GROUP BY period ORDER BY period DESC LIMIT 24`);

export const loanOutstandingReport = () =>
  db.query(
    `SELECT l.loan_number AS loanNumber, u.full_name AS customer, l.principal, l.annual_rate AS annualRate, l.status,
            SUM(s.principal_due - s.principal_paid) AS principalOutstanding,
            SUM(s.interest_due - s.interest_paid) AS interestOutstanding,
            SUM(CASE WHEN s.status = 'overdue' THEN s.total_due - s.principal_paid - s.interest_paid - s.fee_paid ELSE 0 END) AS overdue
       FROM loans l JOIN users u ON u.id = l.user_id JOIN loan_schedules s ON s.loan_id = l.id
      GROUP BY l.id ORDER BY l.id DESC LIMIT 500`
  );

export const repaymentAttempts = (date?: string) =>
  db.query(
    `SELECT a.attempt_date AS date, a.attempt_no AS attemptNo, a.status, a.amount_due AS amountDue, a.amount_debited AS amountDebited, a.shortfall,
            l.loan_number AS loanNumber, u.full_name AS customer
       FROM repayment_attempts a JOIN loans l ON l.id = a.loan_id JOIN users u ON u.id = a.user_id
      ${date ? 'WHERE a.attempt_date = ?' : ''} ORDER BY a.id DESC LIMIT 300`,
    date ? [date] : []
  );

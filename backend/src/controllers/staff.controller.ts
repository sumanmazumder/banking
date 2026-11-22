// Controllers for staff / admin panel: thin request/response layer. Business rules live in ../services; URL wiring lives in ../routes.
import type { Request, Response } from 'express';
import config from '../config';
import { db } from '../db';
import { ApiError, reqCtx } from '../utils/http';
import { addDays, isIsoDate, todayBusiness } from '../utils/dates';
import * as v from '../utils/validators';
import { permsFor } from '../permissions';
import { audit } from '../services/audit.service';
import * as kyc from '../services/kyc.service';
import * as pay from '../services/payment.service';
import * as billing from '../services/billing.service';
import * as ledger from '../services/ledger.service';
import * as adj from '../services/adjustment.service';
import * as interest from '../services/interest.service';
import * as loans from '../services/loan.service';
import * as reports from '../services/report.service';
import * as support from '../services/support.service';
import * as staffSvc from '../services/staff.service';
import * as settings from '../services/settings.service';
import { revokeAllSessions } from '../services/session.service';
import { notify } from '../services/notification.service';
import { recentJobRuns, runDailyJobs } from '../jobs/daily';


const actor = (req: Request) => ({ userId: req.auth!.userId, role: req.auth!.role, sid: req.auth!.sid });
const page = (req: Request) => {
  const p = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
  return { p, size, offset: (p - 1) * size };
};
const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : undefined);
const dateQ = (x: unknown, fallback: string) => (isIsoDate(x) ? x : fallback);


export const getAdminPermissions = async (req: Request, res: Response) =>
  res.json({ role: req.auth!.role, permissions: permsFor(req.auth!.role) });

export const getAdminDashboard = async (_req: Request, res: Response) => res.json(await reports.dashboardSummary());

export const getAdminCustomers = async (req: Request, res: Response) => {
  const { size, offset } = page(req);
  const where: string[] = ["u.role = 'customer'"];
  const params: (string | number)[] = [];
  const search = str(req.query.search);
  if (search) {
    where.push('(u.full_name LIKE ? OR u.email LIKE ? OR u.mobile LIKE ? OR p.customer_number LIKE ? OR a.account_number LIKE ?)');
    const like = `%${search.replace(/[%_]/g, '')}%`;
    params.push(like, like, like, like, like);
  }
  const status = str(req.query.status);
  if (status) { where.push('u.status = ?'); params.push(status); }
  const from = str(req.query.registeredFrom), to = str(req.query.registeredTo);
  if (isIsoDate(from)) { where.push('DATE(u.created_at) >= ?'); params.push(from); }
  if (isIsoDate(to)) { where.push('DATE(u.created_at) <= ?'); params.push(to); }
  const pay_ = str(req.query.paymentStatus);
  if (pay_ === 'overdue') where.push("EXISTS (SELECT 1 FROM billing_dues d WHERE d.user_id = u.id AND d.status = 'overdue')");
  if (pay_ === 'paid_up') where.push("a.status = 'active' AND NOT EXISTS (SELECT 1 FROM billing_dues d WHERE d.user_id = u.id AND d.status IN ('pending','partial','overdue'))");
  const from_ = `FROM users u JOIN customer_profiles p ON p.user_id = u.id LEFT JOIN accounts a ON a.user_id = u.id WHERE ${where.join(' AND ')}`;
  const rows = await db.query(
    `SELECT u.public_id AS id, u.full_name AS fullName, u.email, u.mobile, u.status, u.created_at AS registeredAt,
            p.customer_number AS customerNumber, p.kyc_status AS kycStatus, a.account_number AS accountNumber, a.status AS accountStatus
       ${from_} ORDER BY u.id DESC LIMIT ? OFFSET ?`,
    [...params, size, offset]
  );
  const total = Number((await db.one<{ c: number }>(`SELECT COUNT(*) c ${from_}`, params))!.c);
  res.json({ rows, total });
};

export const getAdminCustomersById = async (req: Request, res: Response) => {
  const u = await db.one<any>(
    `SELECT u.id, u.public_id, u.full_name, u.email, u.mobile, u.status, u.created_at, u.last_login_at, p.customer_number, p.kyc_status, p.address, p.date_of_birth
       FROM users u JOIN customer_profiles p ON p.user_id = u.id WHERE u.public_id = ? AND u.role = 'customer'`,
    [String(req.params.publicId)]
  );
  if (!u) throw new ApiError(404, 'Customer not found', 'NOT_FOUND');
  const acc = await db.one<any>('SELECT * FROM accounts WHERE user_id = ?', [u.id]);
  const out: any = {
    id: u.public_id, fullName: u.full_name, email: u.email, mobile: u.mobile, status: u.status, registeredAt: u.created_at, lastLoginAt: u.last_login_at,
    customerNumber: u.customer_number, kycStatus: u.kyc_status, address: u.address, dateOfBirth: u.date_of_birth, account: null,
    kyc: await kyc.latestKyc(u.id),
  };
  if (acc) {
    out.account = {
      id: acc.public_id, accountNumber: acc.account_number, status: acc.status, openingAmount: acc.opening_amount, activatedAt: acc.activated_at,
      balance: await ledger.savingsBalance(acc.id),
      assignments: await billing.assignmentsForAccount(acc.id),
    };
    out.dues = await billing.duesForUser(u.id);
    out.payments = (await pay.paymentsForUser(u.id)).slice(0, 20);
    out.loans = await loans.loansForUser(u.id);
  }
  res.json(out);
};

export const postAdminCustomersByIdStatus = async (req: Request, res: Response) => {
  const status = req.body.status as 'active' | 'suspended';
  const u = await db.one<any>("SELECT id, status FROM users WHERE public_id = ? AND role = 'customer'", [String(req.params.publicId)]);
  if (!u) throw new ApiError(404, 'Customer not found', 'NOT_FOUND');
  if (status === 'suspended') {
    await db.execute("UPDATE users SET status = 'suspended' WHERE id = ?", [u.id]);
    await db.execute("UPDATE accounts SET status = 'suspended' WHERE user_id = ? AND status = 'active'", [u.id]);
    await revokeAllSessions(u.id, 'admin_suspended');
  } else {
    if (u.status !== 'suspended') throw new ApiError(409, 'Customer is not suspended', 'STATE');
    await db.execute("UPDATE users SET status = 'active' WHERE id = ?", [u.id]);
    await db.execute("UPDATE accounts SET status = 'active' WHERE user_id = ? AND status = 'suspended'", [u.id]);
  }
  await audit(reqCtx(req), { action: `customer.${status}`, entity: 'user', entityId: u.id, before: { status: u.status }, after: { status }, reason: req.body.reason, actor: actor(req) });
  await notify(u.id, `account.${status}`, status === 'suspended' ? 'Account suspended' : 'Account reactivated', status === 'suspended' ? 'Your account was suspended. Please contact support.' : 'Your account was reactivated.');
  res.json({ message: `Customer ${status}` });
};

export const getAdminKyc = async (req: Request, res: Response) => {
  const { p, size } = page(req);
  res.json(await kyc.kycQueue(str(req.query.status) ?? 'pending', p, size));
};

export const getAdminKycById = async (req: Request, res: Response) => res.json(await kyc.kycDetail(Number(req.params.id), actor(req), reqCtx(req)));

export const postAdminKycByIdReview = async (req: Request, res: Response) => {
  await kyc.reviewKyc(Number(req.params.id), req.body.decision, req.body.note, actor(req), reqCtx(req));
  res.json({ message: `KYC ${req.body.decision}` });
};

export const postAdminAccountsByIdContribution = async (req: Request, res: Response) => {
  res.status(201).json(await billing.assignContribution(String(req.params.accountId), req.body, actor(req), reqCtx(req)));
};

export const getAdminDues = async (req: Request, res: Response) => {
  const { size, offset } = page(req);
  const where: string[] = ['1=1'];
  const params: (string | number)[] = [];
  const status = str(req.query.status);
  if (status) { where.push('d.status = ?'); params.push(status); }
  const period = str(req.query.period);
  if (period) { where.push('d.period = ?'); params.push(period); }
  const search = str(req.query.search);
  if (search) { where.push('(u.full_name LIKE ? OR u.email LIKE ? OR a.account_number LIKE ?)'); const l = `%${search.replace(/[%_]/g, '')}%`; params.push(l, l, l); }
  const base = `FROM billing_dues d JOIN accounts a ON a.id = d.account_id JOIN users u ON u.id = d.user_id LEFT JOIN late_fee_assessments f ON f.due_id = d.id WHERE ${where.join(' AND ')}`;
  const rows = await db.query(
    `SELECT d.id, d.period, d.due_amount AS dueAmount, d.paid_amount AS paidAmount, d.due_date AS dueDate, d.grace_end_date AS graceEndDate, d.status,
            u.full_name AS customer, a.account_number AS accountNumber, f.amount AS feeAmount, f.status AS feeStatus
       ${base} ORDER BY d.due_date DESC, d.id DESC LIMIT ? OFFSET ?`,
    [...params, size, offset]
  );
  res.json({ rows, total: Number((await db.one<{ c: number }>(`SELECT COUNT(*) c ${base}`, params))!.c), today: todayBusiness() });
};

export const postAdminDuesByIdWaiveFee = async (req: Request, res: Response) => {
  await billing.waiveLateFee(Number(req.params.id), req.body.reason, actor(req), reqCtx(req));
  res.json({ message: 'Late fee waived' });
};

export const getAdminPayments = async (req: Request, res: Response) => {
  const { size, offset } = page(req);
  const where: string[] = ['1=1'];
  const params: (string | number)[] = [];
  for (const [q, col] of [['status', 'p.status'], ['recon', 'p.recon_status'], ['purpose', 'p.purpose'], ['channel', 'p.channel']] as const) {
    const val = str(req.query[q]);
    if (val) { where.push(`${col} = ?`); params.push(val); }
  }
  const search = str(req.query.search);
  if (search) { where.push('(u.full_name LIKE ? OR p.reference LIKE ? OR p.receipt_no LIKE ?)'); const l = `%${search.replace(/[%_]/g, '')}%`; params.push(l, l, l); }
  const base = `FROM payments p JOIN users u ON u.id = p.user_id LEFT JOIN billing_dues d ON d.id = p.due_id WHERE ${where.join(' AND ')}`;
  const rows = await db.query(
    `SELECT p.id, p.reference, p.purpose, p.amount, p.status, p.channel, p.recon_status AS reconStatus, p.receipt_no AS receiptNo, p.gateway_ref AS gatewayRef,
            p.settled_at AS settledAt, p.created_at AS createdAt, p.note, u.full_name AS customer, d.period
       ${base} ORDER BY p.id DESC LIMIT ? OFFSET ?`,
    [...params, size, offset]
  );
  res.json({ rows, total: Number((await db.one<{ c: number }>(`SELECT COUNT(*) c ${base}`, params))!.c) });
};

export const postAdminPaymentsRecord = async (req: Request, res: Response) => {
  res.status(201).json(await pay.recordStaffPayment(actor(req), req.body.dueId, req.body.amount, req.body.evidence, reqCtx(req)));
};

export const postAdminPaymentsByIdSettle = async (req: Request, res: Response) => {
  res.json(await pay.settlePayment(String(req.params.reference), { actorId: req.auth!.userId, note: 'Confirmed by staff against provider settlement', channel: 'staff' }, reqCtx(req), actor(req)));
};

export const postAdminPaymentsByIdFail = async (req: Request, res: Response) => {
  await pay.failPayment(String(req.params.reference), req.body.reason, reqCtx(req), actor(req));
  res.json({ message: 'Payment marked failed' });
};

export const postAdminPaymentsByIdReconcile = async (req: Request, res: Response) => {
  await pay.reconcilePayment(Number(req.params.id), actor(req), reqCtx(req));
  res.json({ message: 'Payment reconciled' });
};

export const getAdminLedger = async (req: Request, res: Response) => {
  const { size, offset } = page(req);
  const where: string[] = ['1=1'];
  const params: (string | number)[] = [];
  const acct = str(req.query.account);
  if (acct) { where.push('(a.account_number = ? OR a.public_id = ?)'); params.push(acct, acct); }
  const type = str(req.query.type);
  if (type) { where.push('t.tx_type = ?'); params.push(type); }
  const ledgerKind = str(req.query.ledger);
  if (ledgerKind) { where.push('t.ledger = ?'); params.push(ledgerKind); }
  const from = str(req.query.from), to = str(req.query.to);
  if (isIsoDate(from)) { where.push('t.posting_date >= ?'); params.push(from); }
  if (isIsoDate(to)) { where.push('t.posting_date <= ?'); params.push(to); }
  const base = `FROM ledger_transactions t JOIN accounts a ON a.id = t.account_id JOIN users u ON u.id = a.user_id WHERE ${where.join(' AND ')}`;
  const rows = await db.query(
    `SELECT t.id, t.reference, t.posting_date AS date, t.tx_type AS type, t.ledger, t.direction, t.amount, t.description, t.reversal_of AS reversalOf,
            a.account_number AS accountNumber, a.public_id AS accountId, u.full_name AS customer
       ${base} ORDER BY t.id DESC LIMIT ? OFFSET ?`,
    [...params, size, offset]
  );
  res.json({ rows, total: Number((await db.one<{ c: number }>(`SELECT COUNT(*) c ${base}`, params))!.c) });
};

export const getAdminAdjustments = async (req: Request, res: Response) => res.json({ rows: await adj.listAdjustments(str(req.query.status)) });

export const postAdminAdjustments = async (req: Request, res: Response) => {
  res.status(201).json(await adj.requestAdjustment({ ...req.body, accountPublicId: req.body.accountId }, actor(req), reqCtx(req)));
};

export const postAdminAdjustmentsByIdDecide = async (req: Request, res: Response) => {
  await adj.decideAdjustment(Number(req.params.id), req.body.approve, req.body.note, actor(req), reqCtx(req));
  res.json({ message: req.body.approve ? 'Approved and posted' : 'Rejected' });
};

export const getAdminLateFeeRules = async (_req: Request, res: Response) =>
  res.json({ rows: await db.query('SELECT id, fee_type AS feeType, amount, cap_amount AS capAmount, effective_from AS effectiveFrom, created_at AS createdAt FROM late_fee_rules ORDER BY effective_from DESC, id DESC') });

export const postAdminLateFeeRules = async (req: Request, res: Response) => {
  res.status(201).json(await billing.createLateFeeRule(req.body, actor(req), reqCtx(req)));
};

export const getAdminInterestRules = async (_req: Request, res: Response) => res.json({ rows: await interest.listRules() });

export const postAdminInterestRules = async (req: Request, res: Response) => {
  res.status(201).json(await interest.createRule(req.body, actor(req), reqCtx(req)));
};

export const postAdminInterestRulesByIdApprove = async (req: Request, res: Response) => {
  await interest.approveRule(Number(req.params.id), actor(req), reqCtx(req));
  res.json({ message: 'Rule approved and active' });
};

export const postAdminInterestRun = async (req: Request, res: Response) =>
  res.json(await interest.postInterestForPeriod(req.body.period, reqCtx(req), actor(req)));

export const getAdminInterestPostings = async (req: Request, res: Response) => res.json({ rows: await interest.postingsForPeriod(str(req.query.period) ?? todayBusiness().slice(0, 7)) });

export const getAdminLoansApplications = async (req: Request, res: Response) => res.json({ rows: await loans.applicationQueue(str(req.query.status)) });

export const postAdminLoansApplicationsByIdReview = async (req: Request, res: Response) => {
  await loans.reviewApplication(String(req.params.id), req.body, actor(req), reqCtx(req));
  res.json({ message: 'Review recorded' });
};

export const postAdminLoansApplicationsByIdDisburse = async (req: Request, res: Response) =>
  res.status(201).json(await loans.disburse(String(req.params.id), actor(req), reqCtx(req)));

export const getAdminLoans = async (req: Request, res: Response) => {
  const { size, offset } = page(req);
  const status = str(req.query.status);
  const rows = await db.query(
    `SELECT l.public_id AS id, l.loan_number AS loanNumber, u.full_name AS customer, l.principal, l.annual_rate AS annualRate, l.tenure_months AS tenureMonths,
            l.emi_amount AS emi, l.status, l.disbursed_at AS disbursedAt,
            (SELECT COALESCE(SUM(total_due - principal_paid - interest_paid - fee_paid),0) FROM loan_schedules s WHERE s.loan_id = l.id AND s.status = 'overdue') AS overdue
       FROM loans l JOIN users u ON u.id = l.user_id ${status ? 'WHERE l.status = ?' : ''} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    status ? [status, size, offset] : [size, offset]
  );
  res.json({ rows });
};

export const getAdminLoansById = async (req: Request, res: Response) => res.json(await loans.loanDetail(String(req.params.id), null));

export const getAdminReportsCollections = async (req: Request, res: Response) => {
  const to = dateQ(req.query.to, todayBusiness());
  res.json({ rows: await reports.collections(dateQ(req.query.from, addDays(to, -30)), to) });
};

export const getAdminReportsLateFees = async (req: Request, res: Response) => {
  const to = dateQ(req.query.to, todayBusiness());
  res.json({ rows: await reports.lateFeeReport(dateQ(req.query.from, addDays(to, -90)), to) });
};

export const getAdminReportsInterest = async (_req: Request, res: Response) => res.json({ rows: await reports.interestReport() });

export const getAdminReportsLoans = async (_req: Request, res: Response) => res.json({ rows: await reports.loanOutstandingReport() });

export const getAdminReportsRepaymentAttempts = async (req: Request, res: Response) => res.json({ rows: await reports.repaymentAttempts(isIsoDate(req.query.date) ? req.query.date : undefined) });

export const getAdminAudit = async (req: Request, res: Response) => {
  const { size, offset } = page(req);
  const where: string[] = ['1=1'];
  const params: (string | number)[] = [];
  const action = str(req.query.action);
  if (action) { where.push('a.action LIKE ?'); params.push(`${action.replace(/[%_]/g, '')}%`); }
  const entity = str(req.query.entity);
  if (entity) { where.push('a.entity = ?'); params.push(entity); }
  const from = str(req.query.from), to = str(req.query.to);
  if (isIsoDate(from)) { where.push('DATE(a.created_at) >= ?'); params.push(from); }
  if (isIsoDate(to)) { where.push('DATE(a.created_at) <= ?'); params.push(to); }
  const base = `FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id WHERE ${where.join(' AND ')}`;
  const rows = await db.query(
    `SELECT a.id, a.created_at AS createdAt, a.action, a.entity, a.entity_id AS entityId, a.reason, a.ip_address AS ip,
            a.before_json AS \`before\`, a.after_json AS \`after\`, u.full_name AS actor, a.actor_role AS actorRole
       ${base} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    [...params, size, offset]
  );
  res.json({ rows, total: Number((await db.one<{ c: number }>(`SELECT COUNT(*) c ${base}`, params))!.c) });
};

export const getAdminSettings = async (_req: Request, res: Response) => res.json({ rows: await settings.listSettings() });

export const putAdminSettingsById = async (req: Request, res: Response) => {
  const key = String(req.params.key);
  const err = settings.validateSetting(key, req.body.value);
  if (err) throw new ApiError(400, err, 'VALIDATION');
  const before = await db.one<any>('SELECT setting_value FROM settings WHERE setting_key = ?', [key]);
  if (!before) throw new ApiError(404, 'Unknown setting', 'NOT_FOUND');
  await db.execute('UPDATE settings SET setting_value = ?, updated_by = ? WHERE setting_key = ?', [req.body.value, req.auth!.userId, key]);
  await audit(reqCtx(req), { action: 'settings.update', entity: 'setting', entityId: key, before: { value: before.setting_value }, after: { value: req.body.value }, actor: actor(req) });
  res.json({ message: 'Setting updated' });
};

export const getAdminStaff = async (_req: Request, res: Response) => res.json({ rows: await staffSvc.listStaff() });

export const postAdminStaff = async (req: Request, res: Response) => res.status(201).json(await staffSvc.createStaff(req.body, actor(req), reqCtx(req)));

export const patchAdminStaffById = async (req: Request, res: Response) => {
  await staffSvc.updateStaff(String(req.params.id), req.body, actor(req), reqCtx(req));
  res.json({ message: 'Updated' });
};

export const getAdminJobs = async (_req: Request, res: Response) => res.json({ rows: await recentJobRuns() });

export const postAdminJobsRun = async (req: Request, res: Response) => {
  // A custom as-of date lets testers fast-forward (e.g. to see a late fee or a repayment attempt). Never in production.
  const asOf = isIsoDate(req.body?.asOf) ? req.body.asOf : undefined;
  if (asOf && config.isProd) throw new ApiError(403, 'Custom run dates are disabled in production', 'FORBIDDEN');
  const out = await runDailyJobs(asOf, `manual:${req.auth!.userId}`);
  await audit(reqCtx(req), { action: 'jobs.run', entity: 'job', after: { asOf: asOf ?? 'today' }, actor: actor(req) });
  res.json(out);
};

export const getAdminSupport = async (req: Request, res: Response) => res.json({ rows: await support.allTickets(str(req.query.status)) });

export const getAdminSupportById = async (req: Request, res: Response) => res.json(await support.ticketDetail(String(req.params.id), null));

export const postAdminSupportByIdReply = async (req: Request, res: Response) => {
  await support.reply(String(req.params.id), actor(req), req.body.body, reqCtx(req), null);
  res.json({ message: 'Sent' });
};

export const patchAdminSupportById = async (req: Request, res: Response) => {
  const s = req.body?.status;
  if (!['open', 'in_progress', 'resolved', 'closed'].includes(s)) throw new ApiError(400, 'Invalid status', 'VALIDATION');
  await support.setStatus(String(req.params.id), s, actor(req), reqCtx(req));
  res.json({ message: 'Updated' });
};

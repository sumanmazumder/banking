import { Router } from 'express';
import * as c from '../controllers/admin.controller';
import { authenticate, requireRole, STAFF_ROLES } from '../middleware/auth';
import { csrfGuard } from '../middleware/security';
import { validate } from '../middleware/validate';
import { can } from '../permissions';
import * as v from '../utils/validators';
import * as staff from '../controllers/staff.controller';

const r = Router();
r.use(authenticate, requireRole(...STAFF_ROLES));
r.get('/permissions', staff.getAdminPermissions);
/* -------------------------------------- dashboard -------------------------------------- */

r.get('/dashboard', can('reports.read'), staff.getAdminDashboard);
/* ---------------------------------- sessions (existing) ---------------------------------- */

r.get('/users/:publicId/sessions', can('sessions.revoke'), c.userSessions);
r.post('/users/:publicId/sessions/revoke-all', can('sessions.revoke'), csrfGuard, validate(v.reasonSchema), c.revokeAllForUser);
r.delete('/sessions/:sid', can('sessions.revoke'), csrfGuard, validate(v.reasonSchema), c.revokeSessionById);
/* ----------------------------------- customers (FR-ADM-04) ----------------------------------- */

r.get('/customers', can('customers.read'), staff.getAdminCustomers);
r.get('/customers/:publicId', can('customers.read'), staff.getAdminCustomersById);
r.post('/customers/:publicId/status', can('customers.manage'), csrfGuard, validate(v.customerStatusSchema), staff.postAdminCustomersByIdStatus);
/* ------------------------------------------ KYC ------------------------------------------ */

r.get('/kyc', can('customers.read'), staff.getAdminKyc);
r.get('/kyc/:id', can('kyc.review'), staff.getAdminKycById);
r.post('/kyc/:id/review', can('kyc.review'), csrfGuard, validate(v.kycReviewSchema), staff.postAdminKycByIdReview);
/* ------------------------------------- contributions / dues ------------------------------------- */

r.post('/accounts/:accountId/contribution', can('contribution.assign'), csrfGuard, validate(v.assignSchema), staff.postAdminAccountsByIdContribution);
r.get('/dues', can('payments.read'), staff.getAdminDues);
r.post('/dues/:id/waive-fee', can('latefee.waive'), csrfGuard, validate(v.reasonSchema), staff.postAdminDuesByIdWaiveFee);
/* ----------------------------------------- payments ----------------------------------------- */

r.get('/payments', can('payments.read'), staff.getAdminPayments);
r.post('/payments/record', can('payments.record'), csrfGuard, validate(v.staffPaymentSchema), staff.postAdminPaymentsRecord);
// Staff confirm a pending gateway payment after checking the provider settlement (FR-ACC-03).
r.post('/payments/:reference/settle', can('payments.record'), csrfGuard, staff.postAdminPaymentsByIdSettle);
r.post('/payments/:reference/fail', can('payments.record'), csrfGuard, validate(v.reasonSchema), staff.postAdminPaymentsByIdFail);
r.post('/payments/:id/reconcile', can('payments.reconcile'), csrfGuard, staff.postAdminPaymentsByIdReconcile);
/* ------------------------------------------ ledger ------------------------------------------ */

r.get('/ledger', can('ledger.read'), staff.getAdminLedger);
r.get('/adjustments', can('ledger.read'), staff.getAdminAdjustments);
r.post('/adjustments', can('adjust.request'), csrfGuard, validate(v.adjustmentSchema), staff.postAdminAdjustments);
r.post('/adjustments/:id/decide', can('adjust.approve'), csrfGuard, validate(v.decisionSchema), staff.postAdminAdjustmentsByIdDecide);
/* --------------------------------------- late fees / interest --------------------------------------- */

r.get('/late-fee-rules', can('latefee.read'), staff.getAdminLateFeeRules);
r.post('/late-fee-rules', can('latefee.configure'), csrfGuard, validate(v.lateFeeRuleSchema), staff.postAdminLateFeeRules);
r.get('/interest/rules', can('interest.read'), staff.getAdminInterestRules);
r.post('/interest/rules', can('interest.configure'), csrfGuard, validate(v.interestRuleSchema), staff.postAdminInterestRules);
r.post('/interest/rules/:id/approve', can('interest.configure'), csrfGuard, staff.postAdminInterestRulesByIdApprove);
r.post('/interest/run', can('interest.run'), csrfGuard, validate(v.periodSchema), staff.postAdminInterestRun);
r.get('/interest/postings', can('interest.read'), staff.getAdminInterestPostings);
/* ------------------------------------------- loans ------------------------------------------- */

r.get('/loans/applications', can('loans.read'), staff.getAdminLoansApplications);
r.post('/loans/applications/:id/review', can('loans.review'), csrfGuard, validate(v.loanReviewSchema), staff.postAdminLoansApplicationsByIdReview);
r.post('/loans/applications/:id/disburse', can('loans.disburse'), csrfGuard, staff.postAdminLoansApplicationsByIdDisburse);
r.get('/loans', can('loans.read'), staff.getAdminLoans);
r.get('/loans/:id', can('loans.read'), staff.getAdminLoansById);
/* ------------------------------------------ reports ------------------------------------------ */

r.get('/reports/collections', can('reports.read'), staff.getAdminReportsCollections);
r.get('/reports/late-fees', can('reports.read'), staff.getAdminReportsLateFees);
r.get('/reports/interest', can('reports.read'), staff.getAdminReportsInterest);
r.get('/reports/loans', can('reports.read'), staff.getAdminReportsLoans);
r.get('/reports/repayment-attempts', can('reports.read'), staff.getAdminReportsRepaymentAttempts);
/* ------------------------------------------- audit ------------------------------------------- */

r.get('/audit', can('audit.read'), staff.getAdminAudit);
/* ------------------------------------- settings / staff / jobs ------------------------------------- */

r.get('/settings', can('settings.read'), staff.getAdminSettings);
r.put('/settings/:key', can('settings.write'), csrfGuard, validate(v.settingSchema), staff.putAdminSettingsById);
r.get('/staff', can('staff.manage'), staff.getAdminStaff);
r.post('/staff', can('staff.manage'), csrfGuard, validate(v.staffCreateSchema), staff.postAdminStaff);
r.patch('/staff/:id', can('staff.manage'), csrfGuard, validate(v.staffUpdateSchema), staff.patchAdminStaffById);
r.get('/jobs', can('jobs.run'), staff.getAdminJobs);
r.post('/jobs/run', can('jobs.run'), csrfGuard, staff.postAdminJobsRun);
/* ------------------------------------------- support ------------------------------------------- */

r.get('/support', can('support.manage'), staff.getAdminSupport);
r.get('/support/:id', can('support.manage'), staff.getAdminSupportById);
r.post('/support/:id/reply', can('support.manage'), csrfGuard, validate(v.replySchema), staff.postAdminSupportByIdReply);
r.patch('/support/:id', can('support.manage'), csrfGuard, staff.patchAdminSupportById);


export default r;

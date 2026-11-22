import { Router } from 'express';
import { authenticate, requireActive, requireRole } from '../middleware/auth';
import { csrfGuard } from '../middleware/security';
import { validate } from '../middleware/validate';
import * as v from '../utils/validators';
import * as c from '../controllers/customer.controller';

const r = Router();
r.use(authenticate, requireRole('customer'));
/* ------------------------------ overview / onboarding ------------------------------ */

r.get('/overview', c.getOverview);
/* ------------------------------------------ KYC ------------------------------------------ */

r.get('/kyc', c.getKyc);
r.post('/kyc', csrfGuard, validate(v.kycSchema), c.postKyc);
/* ------------------------------------- account opening ------------------------------------- */

r.get('/account/options', c.getAccountOptions);
r.get('/account', c.getAccount);
r.post('/account/opening', csrfGuard, validate(v.openingSchema), c.postAccountOpening);
/* ---------------------------------------- payments ---------------------------------------- */

r.get('/payments', c.getPayments);
r.get('/dues', requireActive, c.getDues);
r.post('/payments/dues', csrfGuard, requireActive, validate(v.payDueSchema), c.postPaymentsDues);
// Prototype gateway: stands in for the provider checkout + webhook. Disabled in production, where only the
// signed webhook (POST /api/payments/webhook) or authorised staff can settle a payment.
r.post('/payments/:reference/simulate', csrfGuard, c.postPaymentsByIdSimulate);
/* ---------------------------------------- passbook ---------------------------------------- */

r.get('/passbook', c.getPassbook);
/* -------------------------------------- notifications -------------------------------------- */

r.get('/notifications', c.getNotifications);
r.post('/notifications/read-all', csrfGuard, c.postNotificationsReadAll);
/* ------------------------------------------ loans ------------------------------------------ */

r.get('/loans/eligibility', c.getLoansEligibility);
r.get('/loans/applications', requireActive, c.getLoansApplications);
r.post('/loans/applications', csrfGuard, requireActive, validate(v.loanApplySchema), c.postLoansApplications);
r.post('/loans/applications/:id/respond', csrfGuard, requireActive, validate(v.termsResponseSchema), c.postLoansApplicationsByIdRespond);
r.get('/loans/dues', requireActive, c.getLoansDues);
r.get('/loans', requireActive, c.getLoans);
r.get('/loans/:id', requireActive, c.getLoansById);
r.post('/loans/:id/repay', csrfGuard, requireActive, validate(v.repaySchema), c.postLoansByIdRepay);
/* ------------------------------------ auto-repayment mandate ------------------------------------ */

r.get('/mandate', requireActive, c.getMandate);
r.post('/mandate', csrfGuard, requireActive, validate(v.mandateSchema), c.postMandate);
r.delete('/mandate', csrfGuard, requireActive, c.deleteMandate);
/* ------------------------------------------ support ------------------------------------------ */

r.get('/support', c.getSupport);
r.post('/support', csrfGuard, validate(v.ticketSchema), c.postSupport);
r.get('/support/:id', c.getSupportById);
r.post('/support/:id/reply', csrfGuard, validate(v.replySchema), c.postSupportByIdReply);


export default r;

// Controllers for customers: thin request/response layer. Business rules live in ../services; URL wiring lives in ../routes.
import type { Request, Response } from 'express';
import config from '../config';
import { db } from '../db';
import { ApiError, reqCtx } from '../utils/http';
import { isoDate } from '../utils/validators';
import * as v from '../utils/validators';
import { todayBusiness } from '../utils/dates';
import * as kyc from '../services/kyc.service';
import * as accounts from '../services/account.service';
import * as pay from '../services/payment.service';
import * as billing from '../services/billing.service';
import * as ledger from '../services/ledger.service';
import * as notif from '../services/notification.service';
import * as loans from '../services/loan.service';
import * as support from '../services/support.service';


const uid = (req: Request) => req.auth!.userId;

const accountOf = async (req: Request) => {
  const a = await accounts.accountForUser(uid(req));
  if (!a) throw new ApiError(404, 'No account yet', 'NO_ACCOUNT');
  return a;
};


export const getOverview = async (req: Request, res: Response) => {
  const userId = uid(req);
  const [account, k, prof] = await Promise.all([
    accounts.accountForUser(userId), kyc.latestKyc(userId),
    db.one<any>('SELECT kyc_status FROM customer_profiles WHERE user_id = ?', [userId]),
  ]);
  const kycStatus = prof?.kyc_status ?? 'not_started';
  const step = !account || account.status === 'pending'
    ? (kycStatus === 'approved' ? 'open_account' : kycStatus === 'under_review' ? 'kyc_review' : 'kyc_needed')
    : 'done';
  let balance: string | null = null, nextDue: any = null, loansSummary: any[] = [], eligibility: any = null, mandate: any = null;
  if (account?.status === 'active') {
    balance = await ledger.savingsBalance(account.id);
    const dues = await billing.duesForUser(userId);
    nextDue = dues.filter((d) => d.status !== 'paid' && d.status !== 'cancelled').sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1))[0] ?? null;
    loansSummary = await loans.loansForUser(userId);
    eligibility = await loans.eligibility(userId);
    mandate = await loans.mandateForUser(userId);
  }
  res.json({
    status: req.auth!.status, onboardingStep: step, kyc: k ?? null, kycStatus,
    account: account ?? null, balance, nextDue, loans: loansSummary, eligibility, mandate,
    unreadNotifications: await notif.unreadCount(userId),
  });
};

export const getKyc = async (req: Request, res: Response) => res.json({ kyc: (await kyc.latestKyc(uid(req))) ?? null });

export const postKyc = async (req: Request, res: Response) => {
  await kyc.submitKyc(uid(req), req.body, reqCtx(req));
  res.status(201).json({ message: 'KYC submitted for review' });
};

export const getAccountOptions = async (_req: Request, res: Response) => res.json(await accounts.openingOptions());

export const getAccount = async (req: Request, res: Response) => res.json({ account: (await accounts.accountForUser(uid(req))) ?? null });

export const postAccountOpening = async (req: Request, res: Response) => {
  res.status(201).json(await accounts.startOpening(uid(req), req.body.amount, reqCtx(req)));
};

export const getPayments = async (req: Request, res: Response) => res.json({ payments: await pay.paymentsForUser(uid(req)) });

export const getDues = async (req: Request, res: Response) => res.json({ dues: await billing.duesForUser(uid(req)) });

export const postPaymentsDues = async (req: Request, res: Response) => {
  res.status(201).json(await pay.startDuePayment(uid(req), req.body.dueId, req.body.amount, reqCtx(req)));
};

export const postPaymentsByIdSimulate = async (req: Request, res: Response) => {
  if (config.isProd) throw new ApiError(404, 'Route not found', 'NOT_FOUND');
  const p = await db.one<any>('SELECT id, user_id, status FROM payments WHERE reference = ?', [String(req.params.reference)]);
  if (!p || p.user_id !== uid(req)) throw new ApiError(404, 'Payment not found', 'NOT_FOUND');
  const out = await pay.settlePayment(String(req.params.reference), { gatewayRef: `SIM-${Date.now()}`, channel: 'gateway' }, reqCtx(req), { userId: uid(req), role: 'customer', sid: req.auth!.sid });
  res.json(out);
};

export const getPassbook = async (req: Request, res: Response) => {
  const acc = await accountOf(req);
  const from = isoDate.optional().parse(req.query.from || undefined);
  const to = isoDate.optional().parse(req.query.to || undefined);
  const pb = await ledger.passbook(acc.id, from, to);
  const pending = await db.query(
    "SELECT reference, amount, purpose, created_at AS createdAt FROM payments WHERE user_id = ? AND status = 'pending' ORDER BY id DESC",
    [uid(req)]
  );
  res.json({
    account: { accountNumber: acc.accountNumber, customerNumber: acc.customerNumber, status: acc.status },
    holder: (await db.one<any>('SELECT full_name AS name FROM users WHERE id = ?', [uid(req)]))?.name,
    from: from ?? null, to: to ?? null, generatedAt: new Date().toISOString(), today: todayBusiness(),
    ...pb, pending, // pending payments are listed separately and never counted in the balance (FR-PASS-05)
  });
};

export const getNotifications = async (req: Request, res: Response) => res.json({ notifications: await notif.listForUser(uid(req)), unread: await notif.unreadCount(uid(req)) });

export const postNotificationsReadAll = async (req: Request, res: Response) => {
  await notif.markAllRead(uid(req));
  res.json({ message: 'ok' });
};

export const getLoansEligibility = async (req: Request, res: Response) => res.json({ ...(await loans.eligibility(uid(req))), terms: await loans.loanTerms() });

export const getLoansApplications = async (req: Request, res: Response) => res.json({ applications: await loans.applicationsForUser(uid(req)) });

export const postLoansApplications = async (req: Request, res: Response) => {
  res.status(201).json(await loans.applyForLoan(uid(req), req.body, reqCtx(req)));
};

export const postLoansApplicationsByIdRespond = async (req: Request, res: Response) => {
  await loans.respondToTerms(uid(req), String(req.params.id), req.body.accept, reqCtx(req));
  res.json({ message: req.body.accept ? 'Terms accepted' : 'Application cancelled' });
};

export const getLoansDues = async (req: Request, res: Response) => res.json({ dues: await loans.duesSummary(uid(req)) });

export const getLoans = async (req: Request, res: Response) => res.json({ loans: await loans.loansForUser(uid(req)) });

export const getLoansById = async (req: Request, res: Response) => res.json(await loans.loanDetail(String(req.params.id), uid(req)));

export const postLoansByIdRepay = async (req: Request, res: Response) => {
  res.json(await loans.manualRepay(uid(req), String(req.params.id), req.body.amount, reqCtx(req)));
};

export const getMandate = async (req: Request, res: Response) => res.json({ mandate: (await loans.mandateForUser(uid(req))) ?? null, consentText: loans.CONSENT_TEXT });

export const postMandate = async (req: Request, res: Response) => {
  res.status(201).json(await loans.createMandate(uid(req), req.body.validUntil, reqCtx(req)));
};

export const deleteMandate = async (req: Request, res: Response) => {
  await loans.revokeMandate(uid(req), reqCtx(req));
  res.json({ message: 'Mandate revoked' });
};

export const getSupport = async (req: Request, res: Response) => res.json({ tickets: await support.ticketsForUser(uid(req)) });

export const postSupport = async (req: Request, res: Response) => res.status(201).json(await support.createTicket(uid(req), req.body, reqCtx(req)));

export const getSupportById = async (req: Request, res: Response) => res.json(await support.ticketDetail(String(req.params.id), uid(req)));

export const postSupportByIdReply = async (req: Request, res: Response) => {
  await support.reply(String(req.params.id), { userId: uid(req), role: 'customer' }, req.body.body, reqCtx(req), uid(req));
  res.json({ message: 'Sent' });
};

import { z } from 'zod';

const email = z.string().trim().toLowerCase().pipe(z.email());

export const passwordRule = z
  .string()
  .min(10, 'Minimum 10 characters')
  .max(128)
  .regex(/[a-z]/, 'Needs a lowercase letter')
  .regex(/[A-Z]/, 'Needs an uppercase letter')
  .regex(/\d/, 'Needs a digit')
  .regex(/[^A-Za-z0-9]/, 'Needs a special character');

export const registerSchema = z.object({
  fullName: z.string().trim().min(2).max(150),
  email,
  mobile: z.string().trim().regex(/^\+?[0-9]{10,15}$/, 'Invalid mobile number'),
  password: passwordRule,
  consent: z.literal(true, { error: 'Consent is required' }),
});
export const verifyOtpSchema = z.object({ email, code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits') });
export const emailOnlySchema = z.object({ email });
export const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(128),
  newPassword: passwordRule,
});
export const resetPasswordSchema = z.object({ email, code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'), newPassword: passwordRule });

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const money = z.string().trim().regex(/^\d{1,12}(\.\d{1,2})?$/, 'Enter a valid amount');

export const kycSchema = z.object({
  documentType: z.enum(['aadhaar', 'pan', 'passport', 'voter_id', 'driving_licence']),
  documentNumber: z.string().trim().min(5).max(30),
  address: z.string().trim().min(10, 'Enter your full address').max(500),
  dateOfBirth: isoDate,
});
export const kycReviewSchema = z.object({
  decision: z.enum(['approved', 'rejected', 'more_info']),
  note: z.string().trim().min(5, 'A note is required (min 5 characters)').max(500),
});
export const openingSchema = z.object({ amount: money });
export const payDueSchema = z.object({ dueId: z.coerce.number().int().positive(), amount: money.optional() });
export const assignSchema = z.object({
  amount: money,
  dueDay: z.coerce.number().int().min(1).max(28),
  graceDays: z.coerce.number().int().min(0).max(30).default(3),
  effectiveFrom: isoDate,
});
export const staffPaymentSchema = z.object({
  dueId: z.coerce.number().int().positive(),
  amount: money,
  evidence: z.string().trim().min(5, 'Receipt/evidence reference required').max(255),
});
export const lateFeeRuleSchema = z.object({
  feeType: z.enum(['fixed', 'percent']),
  amount: z.string().regex(/^\d{1,8}(\.\d{1,4})?$/),
  capAmount: money.nullable().default(null),
  effectiveFrom: isoDate,
});
export const interestRuleSchema = z.object({
  ratePercent: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/),
  ratePeriod: z.enum(['monthly', 'annual']),
  compounding: z.enum(['simple', 'compound']),
  minBalance: money.default('0'),
  effectiveFrom: isoDate,
  note: z.string().trim().max(500).optional(),
});
export const adjustmentSchema = z.object({
  accountId: z.string().uuid(),
  kind: z.enum(['adjustment', 'reversal']),
  direction: z.enum(['debit', 'credit']).optional(),
  amount: money.optional(),
  targetTxnId: z.coerce.number().int().positive().optional(),
  reason: z.string().trim().min(5).max(500),
});
export const decisionSchema = z.object({ approve: z.boolean(), note: z.string().trim().min(5, 'A note is required (min 5 characters)').max(500) });
export const loanApplySchema = z.object({
  amount: money,
  purpose: z.string().trim().min(5).max(300),
  tenureMonths: z.coerce.number().int().min(1).max(120),
  documentsNote: z.string().trim().max(500).optional(),
});
export const loanReviewSchema = z.object({
  decision: z.enum(['approve', 'reject', 'more_info']),
  note: z.string().trim().min(5, 'A reason is required (min 5 characters)').max(500),
  amount: money.optional(),
  rate: z.coerce.number().min(0).max(60).optional(),
  tenureMonths: z.coerce.number().int().min(1).max(120).optional(),
  firstDueDate: isoDate.optional(),
});
export const repaySchema = z.object({ amount: money });
export const mandateSchema = z.object({ validUntil: isoDate.nullable().default(null), consent: z.literal(true, { error: 'Consent is required' }) });
export const ticketSchema = z.object({
  category: z.string().trim().min(2).max(40),
  subject: z.string().trim().min(3).max(160),
  message: z.string().trim().min(5).max(2000),
});
export const replySchema = z.object({ body: z.string().trim().min(1).max(2000) });
export const settingSchema = z.object({ value: z.string().trim().min(1).max(255) });
export const staffCreateSchema = z.object({
  fullName: z.string().trim().min(2).max(150),
  email,
  role: z.enum(['super_admin', 'admin', 'finance_officer', 'auditor']),
  password: passwordRule,
});
export const staffUpdateSchema = z.object({
  role: z.enum(['super_admin', 'admin', 'finance_officer', 'auditor']).optional(),
  status: z.enum(['active', 'suspended']).optional(),
});
export const periodSchema = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM') });
export const customerStatusSchema = z.object({
  status: z.enum(['active', 'suspended']),
  reason: z.string().trim().min(5, 'Reason must be at least 5 characters').max(500),
});
export const termsResponseSchema = z.object({ accept: z.boolean() });
export const reasonSchema = z.object({ reason: z.string().trim().min(5, 'Reason must be at least 5 characters').max(500) });

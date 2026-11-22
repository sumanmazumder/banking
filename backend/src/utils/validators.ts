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
export const reasonSchema = z.object({ reason: z.string().trim().min(5, 'Reason must be at least 5 characters').max(500) });

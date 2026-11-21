import { Router } from 'express';
import * as c from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth';
import { authLimiter, csrfGuard } from '../middleware/security';
import { validate } from '../middleware/validate';
import { emailOnlySchema, loginSchema, registerSchema, verifyOtpSchema } from '../utils/validators';

const r = Router();

r.post('/register', authLimiter, validate(registerSchema), c.register);
r.post('/verify-otp', authLimiter, validate(verifyOtpSchema), c.verifyOtp);
r.post('/resend-otp', authLimiter, validate(emailOnlySchema), c.resendOtp);
r.post('/login', authLimiter, validate(loginSchema), c.login);
r.post('/refresh', csrfGuard, authLimiter, c.refresh); // cookie-backed => CSRF guard
r.post('/logout', csrfGuard, authenticate, c.logout);
r.post('/logout-all', csrfGuard, authenticate, c.logoutAll);
r.get('/me', authenticate, c.me);

export default r;

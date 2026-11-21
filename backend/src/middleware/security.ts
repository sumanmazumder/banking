import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import config from '../config';
import { ApiError, maskIp } from '../utils/http';

export const authLimiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  limit: config.RATE_LIMIT_AUTH_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' } },
});

// CSRF defence for cookie-backed endpoints (refresh/logout): SameSite=Strict cookie PLUS a required
// custom header (cannot be sent cross-site without a CORS preflight) and an Origin check.
export const csrfGuard = (req: Request, _res: Response, next: NextFunction) => {
  if (req.get('x-requested-with') !== 'banking-web') throw new ApiError(403, 'CSRF check failed', 'CSRF');
  const origin = req.get('origin');
  if (origin && !config.corsOrigins.includes(origin)) throw new ApiError(403, 'Origin not allowed', 'CSRF');
  next();
};

export const attachRequestMeta = (req: Request, _res: Response, next: NextFunction) => {
  req.maskedIp = maskIp(req.ip);
  next();
};

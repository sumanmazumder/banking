import type { CookieOptions, Request } from 'express';
import config from '../config';

export class ApiError extends Error {
  details?: unknown;
  alertUser?: { email: string; name: string };
  constructor(public status: number, message: string, public code: string = 'ERROR') {
    super(message);
  }
}

/** Request metadata passed down to services (kept free of Express types). */
export interface ReqCtx {
  maskedIp: string | null;
  userAgent: string;
}

export const maskIp = (ip = ''): string | null => {
  const v4 = ip.replace('::ffff:', '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return v4.replace(/\.\d+$/, '.xxx');
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + ':xxxx';
  return null;
};

export const reqCtx = (req: Request): ReqCtx => ({
  maskedIp: req.maskedIp ?? maskIp(req.ip),
  userAgent: (req.get('user-agent') || '').slice(0, 512),
});

export const parseUserAgent = (ua = '') => {
  const browser =
    (/Edg\//.test(ua) && 'Edge') ||
    (/OPR\//.test(ua) && 'Opera') ||
    (/Chrome\//.test(ua) && 'Chrome') ||
    (/Firefox\//.test(ua) && 'Firefox') ||
    (/Safari\//.test(ua) && 'Safari') ||
    'Unknown browser';
  const os =
    (/Windows/.test(ua) && 'Windows') ||
    (/Android/.test(ua) && 'Android') ||
    (/iPhone|iPad|iOS/.test(ua) && 'iOS') ||
    (/Mac OS X/.test(ua) && 'macOS') ||
    (/Linux/.test(ua) && 'Linux') ||
    'Unknown OS';
  return { browser, os, deviceName: `${browser} on ${os}` };
};

export const REFRESH_COOKIE = 'refresh_token';
export const refreshCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: config.cookieSecure,
  sameSite: 'strict',
  path: '/api/auth', // only sent to refresh/logout endpoints
  maxAge: config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
});
export const clearCookieOptions = (): CookieOptions => {
  const { maxAge: _m, ...rest } = refreshCookieOptions();
  return rest;
};

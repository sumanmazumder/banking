import crypto from 'crypto';
import config from '../config';

// Keyed hash (HMAC-SHA256 with server-side pepper) for refresh tokens and OTPs.
export const hmac = (value: string | number): string =>
  crypto.createHmac('sha256', config.TOKEN_HASH_PEPPER).update(String(value)).digest('hex');

export const safeEqualHex = (a?: string | null, b?: string | null): boolean => {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
};

export const randomToken = (bytes = 48): string => crypto.randomBytes(bytes).toString('base64url');
export const otpCode = (): string => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

// AES-256-GCM helpers for sensitive fields such as KYC document references (SRS FR-CUS-07).
const key = Buffer.from(config.DATA_ENCRYPTION_KEY, 'hex');
export const encrypt = (plain: string): string => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
};
export const decrypt = (blob: string): string => {
  const buf = Buffer.from(blob, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
};

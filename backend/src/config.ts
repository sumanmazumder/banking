import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { z } from 'zod';

export const ROOT = path.resolve(__dirname, '..');

// Environment file is chosen by APP_ENV (development | test | demo), falling back to NODE_ENV.
// .env.development (gitignored, real secrets) / .env.test / .env.demo (templates, no real secrets)
const appEnv = process.env.APP_ENV || process.env.NODE_ENV || 'development';
dotenv.config({ path: path.join(ROOT, `.env.${appEnv}`), quiet: true });

const bool = z.enum(['true', 'false']).default('false');

const schema = z.object({
  APP_ENV: z.string().default(appEnv),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(5000),
  APP_NAME: z.string().default('Banking Management System'),
  FRONTEND_URL: z.string().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().default(3306),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().default(''),
  DB_ADMIN_USER: z.string().default('root'),
  DB_ADMIN_PASSWORD: z.string().default(''),

  JWT_PRIVATE_KEY_PATH: z.string(),
  JWT_PUBLIC_KEY_PATH: z.string(),
  JWT_ALGORITHM: z.enum(['RS256', 'ES256']).default('RS256'),
  JWT_ISSUER: z.string().default('banking-api'),
  JWT_AUDIENCE: z.string().default('banking-web'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(7),
  MAX_ACTIVE_SESSIONS: z.coerce.number().default(5),

  COOKIE_SECRET: z.string().min(32),
  COOKIE_SECURE: bool,
  TOKEN_HASH_PEPPER: z.string().min(32),
  DATA_ENCRYPTION_KEY: z.string().length(64),

  EMAIL_PROVIDER: z.string().default('smtp'),
  SMTP_HOST: z.string().default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_SECURE: bool,
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  EMAIL_FROM: z.string().default('Banking System <no-reply@localhost>'),

  PAYMENT_PROVIDER: z.string().default('razorpay'),
  RAZORPAY_KEY_ID: z.string().default(''),
  RAZORPAY_KEY_SECRET: z.string().default(''),
  RAZORPAY_WEBHOOK_SECRET: z.string().default(''),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(900000),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().default(20),
  BUSINESS_TIMEZONE: z.string().default('Asia/Kolkata'),

  SEED_ADMIN_EMAIL: z.string().default('admin@example.com'),
  SEED_ADMIN_PASSWORD: z.string().default('ChangeMe@12345'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error(`Invalid environment configuration (.env.${appEnv}):`);
  for (const issue of parsed.error.issues) console.error(` - ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}
const e = parsed.data;

const readKey = (p: string): string => {
  const full = path.resolve(ROOT, p);
  if (!fs.existsSync(full)) {
    console.error(`JWT key not found at ${full}. Run: npm run keys:generate`);
    process.exit(1);
  }
  return fs.readFileSync(full, 'utf8');
};

const config = {
  ...e,
  isProd: e.NODE_ENV === 'production',
  cookieSecure: e.COOKIE_SECURE === 'true',
  corsOrigins: e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  jwtPrivateKey: readKey(e.JWT_PRIVATE_KEY_PATH),
  jwtPublicKey: readKey(e.JWT_PUBLIC_KEY_PATH),
};

export default config;

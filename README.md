# Banking Management System

Next.js (frontend) + Node.js/Express (backend) + MySQL, JWT access + rotating refresh tokens, per SRS v1.1.

```
banking/
  backend/    Express + TypeScript API (MySQL, JWT)            -> http://localhost:5000
  frontend/   Next.js app (customer + admin)            -> http://localhost:3000
```

## Backend layout (backend/)

```
migrations/   versioned SQL (npm run db:migrate)       sql/      manual SQL helpers
public/       static files served at /public           uploads/  private uploads (KYC) - never served
src/
  config.ts   loads .env.<APP_ENV>, validates (zod)     db.ts     MySQL pool + query/one/execute
  server.ts   Express bootstrap
  routes/ -> controllers/ -> services/ -> models/        request -> business logic -> SQL
  middleware/ auth (JWT + session), security (CSRF, rate limit), validate, error
  breakers/   circuit breakers for external calls (email now, payments later)
  utils/      crypto, http helpers, validators, DB/key CLI scripts
```

Scripts: `dev`, `dev:test`, `dev:demo`, `build`, `start`, `typecheck`, `db:setup`, `db:migrate`, `db:seed`, `keys:generate`.

The frontend calls the API as `NEXT_PUBLIC_BASE_URL` (frontend/.env.local) + the paths in `frontend/lib/endpoints.js`.

## 1. Connect local MySQL (backend)

MySQL 8.0 runs as the `MySQL80` Windows service. The client is at
`C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe`.

1. Open `backend/.env.development` and set:
   - `DB_ADMIN_PASSWORD` = your MySQL **root** password (only used once, by `db:create`)
   - `DB_PASSWORD` = a new password you choose for the app user `banking_app`
2. From `backend/` run:
   ```
   npm run db:setup     # creates DB + least-privilege user, runs migrations, seeds super admin
   npm run dev          # starts the API
   ```
3. Check: open http://localhost:5000/api/health -> `{"status":"ok","db":"up"}`.

Super admin seeded from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` in `.env.development` - change the password after first login.

If you forgot the root password, reset it per the MySQL docs (stop service, `--skip-grant-tables`).

## 2. Where secrets live

| File | Purpose | Committed? |
|---|---|---|
| `backend/.env.development` | Local dev secrets (DB, JWT, cookie, payment, email) | **No** |
| `backend/.env.test` | Test run: port 5001, DB `banking_test`, throwaway secrets | Yes |
| `backend/.env.demo` | Demo/staging template, secrets left blank | Yes |
| `backend/keys/*.pem` | RS256 JWT key pair (`npm run keys:generate`) | **No** |
| `frontend/.env.local` | Public values only (`NEXT_PUBLIC_*`) | **No** |

Never put a secret in a `NEXT_PUBLIC_*` variable - it ships to the browser.
Regenerating JWT keys (`--force`) signs every user out.

## 3. Email

- **Local dev:** run [Mailpit](https://mailpit.axllent.org/) (SMTP on 1025, inbox UI on http://localhost:8025). Defaults in `.env.development` already match. Without it, emails/OTPs are printed to the backend console in dev.
- **Production:** keep SMTP via nodemailer and point `SMTP_*` at AWS SES (cheap, India region `ap-south-1`), Brevo, or SendGrid. Verify your sending domain (SPF, DKIM, DMARC) before launch.
- Phase 2: move sending to a queue with retries and a delivery-status table (SRS 5.11).

## 4. Payments

- Use an RBI-authorised payment aggregator; do not build card/UPI processing yourself (SRS 2.3).
- **Recommended: Razorpay** (test mode is free, good Next.js docs, UPI/cards/net banking, webhooks). Alternatives: Cashfree, PayU, Stripe India (invite-only).
- Flow (SRS FR-ACC / FR-MON): backend creates an order and a `pending` payment row -> frontend opens Razorpay Checkout using `NEXT_PUBLIC_RAZORPAY_KEY_ID` -> **backend verifies the webhook signature** (`RAZORPAY_WEBHOOK_SECRET`) -> only then post to the ledger. Never trust the browser success redirect.
- Webhooks need a public URL in dev: use `ngrok` or `cloudflared`.
- Fill `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` from the Razorpay dashboard (test mode).
- Do not go live until the legal operating model is confirmed (SRS Phase 0 / release gate).

## 5. API implemented so far (Phase 1 auth)

`POST /api/auth/register | verify-otp | resend-otp | login | refresh | logout | logout-all`, `GET /api/auth/me`,
`GET /api/sessions`, `DELETE /api/sessions/:sid`, `POST /api/sessions/logout-others`,
admin: `GET /api/admin/users/:publicId/sessions`, `POST .../sessions/revoke-all`, `DELETE /api/admin/sessions/:sid`.

Not yet built: mobile OTP (needs an SMS provider), password reset, KYC, accounts, ledger, loans.

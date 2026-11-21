import nodemailer from 'nodemailer';
import config from '../config';
import { createBreaker } from './index';

export interface MailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

// SMTP transport: Mailpit/Mailtrap in dev; AWS SES / SendGrid / Brevo SMTP in production.
const transporter = nodemailer.createTransport({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  secure: config.SMTP_SECURE === 'true',
  auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
  connectionTimeout: 5000,
});

const emailBreaker = createBreaker('email', async (m: MailInput) => {
  await transporter.sendMail({ from: config.EMAIL_FROM, ...m });
  return true;
});

/** Never throws: returns false if the email could not be sent (breaker open, SMTP down, ...). */
export async function sendViaBreaker(m: MailInput): Promise<boolean> {
  try {
    return await emailBreaker.fire(m);
  } catch (err) {
    console.error(`Email to ${m.to} failed: ${(err as Error).message}`);
    if (!config.isProd) {
      console.log(`\n---- DEV EMAIL (not delivered) ----\nTo: ${m.to}\nSubject: ${m.subject}\n${m.text}\n-----------------------------------\n`);
    }
    return false;
  }
}

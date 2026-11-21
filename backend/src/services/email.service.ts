import config from '../config';
import { sendViaBreaker } from '../breakers/email.breaker';

// TODO (Phase 2): move to a durable queue with retry + delivery-status table (SRS 5.11).
export const sendOtpEmail = (to: string, name: string, code: string) =>
  sendViaBreaker({
    to,
    subject: `${config.APP_NAME}: your verification code`,
    text: `Hello ${name},\n\nYour verification code is ${code}. It expires in 10 minutes.\nIf you did not request this, ignore this email.`,
  });

export const sendSecurityEmail = (to: string, name: string, message: string) =>
  sendViaBreaker({
    to,
    subject: `${config.APP_NAME}: security notice`,
    text: `Hello ${name},\n\n${message}\n\nIf this wasn't you, reset your password immediately.`,
  });

import express, { type Request, type Response } from 'express';
import config from '../config';
import { reqCtx } from '../utils/http';
import { settlePayment, failPayment, verifyWebhookSignature } from '../services/payment.service';

/**
 * Payment-provider webhook (server-to-server, SRS section 10: never trust the browser redirect).
 * Needs the RAW body to verify the HMAC signature, so server.ts mounts this BEFORE express.json().
 * Adapter point: map your provider's payload to { event, reference, gatewayRef }.
 * Settlement is idempotent, so provider retries are safe.
 */
export const webhookHandler = [
  express.raw({ type: '*/*', limit: '100kb' }),
  async (req: Request, res: Response) => {
    const secret = config.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return void res.status(503).json({ error: { code: 'WEBHOOK_DISABLED', message: 'Webhook secret is not configured' } });
    const raw = req.body as Buffer;
    if (!Buffer.isBuffer(raw) || !verifyWebhookSignature(raw, req.get('x-signature') || req.get('x-razorpay-signature') || undefined, secret)) {
      return void res.status(401).json({ error: { code: 'BAD_SIGNATURE', message: 'Invalid signature' } });
    }
    let body: { event?: string; reference?: string; gatewayRef?: string };
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return void res.status(400).json({ error: { code: 'BAD_PAYLOAD', message: 'Invalid JSON' } });
    }
    if (!body.reference) return void res.status(400).json({ error: { code: 'BAD_PAYLOAD', message: 'reference required' } });
    const ctx = reqCtx(req);
    if (body.event === 'payment.captured') await settlePayment(body.reference, { gatewayRef: body.gatewayRef ?? null, channel: 'gateway' }, ctx);
    else if (body.event === 'payment.failed') await failPayment(body.reference, 'Failed at payment provider', ctx).catch(() => undefined);
    res.json({ received: true });
  },
];

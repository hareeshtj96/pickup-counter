import { Router } from 'express';
import { env } from '../config/env.js';
import { postPaymentWebhook } from '../controllers/payments.controller.js';
import { parseRawJson } from '../middleware/parseRawJson.js';
import { validate } from '../middleware/validate.js';
import { verifyWebhookSignature } from '../middleware/verifyWebhookSignature.js';
import { paymentWebhookSchema } from '../schemas/payments.schema.js';

export const paymentsRouter = Router();

// Order matters: signature on the raw bytes first, then parse, then validate.
paymentsRouter.post(
  '/webhook',
  verifyWebhookSignature(env.PAYMENT_WEBHOOK_SECRET),
  parseRawJson,
  validate({ body: paymentWebhookSchema }),
  postPaymentWebhook,
);

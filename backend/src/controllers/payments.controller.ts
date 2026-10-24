import type { Request, Response } from 'express';
import type { PaymentWebhookPayload } from '../schemas/payments.schema.js';
import { processPaymentEvent } from '../services/payments.service.js';

// The signature was verified, and the body parsed and validated, by the
// middleware chain in payments.routes.ts.
export async function postPaymentWebhook(_req: Request, res: Response): Promise<void> {
  const locals = res.locals as { validated: { body: PaymentWebhookPayload }; rawBody: string };
  const result = await processPaymentEvent(locals.validated.body, locals.rawBody);
  // 200 for every processed or duplicate event, so the provider stops retrying.
  res.status(200).json(result);
}

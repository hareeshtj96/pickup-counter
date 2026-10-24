import { Router } from 'express';
import { postSimulatePayment } from '../controllers/dev.controller.js';
import { requireJson } from '../middleware/requireJson.js';
import { validate } from '../middleware/validate.js';
import { collectOrderBodySchema, orderIdParamsSchema } from '../schemas/orders.schema.js';

/** DEVELOPMENT ONLY routes; mounted only when DEV_PAYMENT_SIMULATOR=true. */
export const devRouter = Router();

// Content-Type must be JSON; the body must be empty: the amount and event id
// are decided by the server.
devRouter.post(
  '/orders/:id/simulate-payment',
  requireJson,
  validate({ params: orderIdParamsSchema, body: collectOrderBodySchema }),
  postSimulatePayment,
);

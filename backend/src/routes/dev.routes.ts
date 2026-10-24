import { Router } from 'express';
import { postSimulatePayment } from '../controllers/dev.controller.js';
import { validate } from '../middleware/validate.js';
import { collectOrderBodySchema, orderIdParamsSchema } from '../schemas/orders.schema.js';

/** DEVELOPMENT ONLY routes; mounted only when DEV_PAYMENT_SIMULATOR=true. */
export const devRouter = Router();

// No body: the amount and event id are decided by the server.
devRouter.post(
  '/orders/:id/simulate-payment',
  validate({ params: orderIdParamsSchema, body: collectOrderBodySchema }),
  postSimulatePayment,
);

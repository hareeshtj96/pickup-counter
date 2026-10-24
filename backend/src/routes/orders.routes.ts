import { Router } from 'express';
import { getOrderById, postCollectOrder, postOrder, postPickupClaim } from '../controllers/orders.controller.js';
import { requireJson } from '../middleware/requireJson.js';
import { validate } from '../middleware/validate.js';
import { collectOrderBodySchema, createOrderBodySchema, orderIdParamsSchema } from '../schemas/orders.schema.js';

export const ordersRouter = Router();

const collectionInput = [
  requireJson,
  validate({ params: orderIdParamsSchema, body: collectOrderBodySchema }),
];

ordersRouter.post('/', validate({ body: createOrderBodySchema }), postOrder);
ordersRouter.get('/:id', validate({ params: orderIdParamsSchema }), getOrderById);
// Pickup claim: exactly one claim succeeds; the competing/repeated claim gets 409.
ordersRouter.post('/:id/pickup-claim', ...collectionInput, postPickupClaim);
// Idempotent variant: a repeat returns 200 with alreadyCollected: true.
ordersRouter.post('/:id/collect', ...collectionInput, postCollectOrder);

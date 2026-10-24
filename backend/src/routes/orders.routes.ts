import { Router } from 'express';
import { getOrderById, postCollectOrder, postOrder } from '../controllers/orders.controller.js';
import { validate } from '../middleware/validate.js';
import { collectOrderBodySchema, createOrderBodySchema, orderIdParamsSchema } from '../schemas/orders.schema.js';

export const ordersRouter = Router();

ordersRouter.post('/', validate({ body: createOrderBodySchema }), postOrder);
ordersRouter.get('/:id', validate({ params: orderIdParamsSchema }), getOrderById);
ordersRouter.post(
  '/:id/collect',
  validate({ params: orderIdParamsSchema, body: collectOrderBodySchema }),
  postCollectOrder,
);

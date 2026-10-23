import { Router } from 'express';
import { getOrderById, postOrder } from '../controllers/orders.controller.js';
import { validate } from '../middleware/validate.js';
import { createOrderBodySchema, orderIdParamsSchema } from '../schemas/orders.schema.js';

export const ordersRouter = Router();

ordersRouter.post('/', validate({ body: createOrderBodySchema }), postOrder);
ordersRouter.get('/:id', validate({ params: orderIdParamsSchema }), getOrderById);

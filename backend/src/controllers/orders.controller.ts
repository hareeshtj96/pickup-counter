import type { Request, Response } from 'express';
import { AppError } from '../errors/AppError.js';
import type { CreateOrderBody, OrderIdParams } from '../schemas/orders.schema.js';
import { collectOrder, createOrder, getOrder } from '../services/orders.service.js';

// Inputs were parsed by the validate() middleware and stored on res.locals.

export async function postOrder(_req: Request, res: Response): Promise<void> {
  const { body } = (res.locals as { validated: { body: CreateOrderBody } }).validated;
  const order = await createOrder(body.items);
  res.status(201).location(`/api/orders/${order.id}`).json(order);
}

export async function getOrderById(_req: Request, res: Response): Promise<void> {
  const { params } = (res.locals as { validated: { params: OrderIdParams } }).validated;
  const order = await getOrder(params.id);
  if (!order) {
    throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  }
  res.json(order);
}

export async function postCollectOrder(_req: Request, res: Response): Promise<void> {
  const { params } = (res.locals as { validated: { params: OrderIdParams } }).validated;
  // 200 both for the collection and for a repeat (alreadyCollected: true).
  res.json(await collectOrder(params.id));
}

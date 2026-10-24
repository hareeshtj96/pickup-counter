import type { Request, Response } from 'express';
import type { OrderIdParams } from '../schemas/orders.schema.js';
import { simulatePayment } from '../services/devPayments.service.js';

export async function postSimulatePayment(_req: Request, res: Response): Promise<void> {
  const { params } = (res.locals as { validated: { params: OrderIdParams } }).validated;
  res.json(await simulatePayment(params.id));
}

import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';
import { type PaymentEventResult, processPaymentEvent } from './payments.service.js';

/**
 * DEVELOPMENT ONLY. Simulates the payment provider capturing the full order
 * amount, so the browser demo can pay without ever holding the webhook secret.
 *
 * It does not bypass anything: the event goes through the same
 * processPaymentEvent() as a signed webhook (order lock, deadline check under
 * lock, idempotency, needs_review rules). The amount is the order's stored
 * total and the event id is generated here; the caller supplies neither.
 * The route is only registered when DEV_PAYMENT_SIMULATOR=true, which env
 * validation refuses in production.
 */
export async function simulatePayment(orderId: string): Promise<PaymentEventResult> {
  const { rows } = await pool.query<{ total_paise: number }>('SELECT total_paise FROM orders WHERE id = $1', [
    orderId,
  ]);
  const order = rows[0];
  if (!order) {
    throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  }

  const event = {
    eventId: `devsim_${randomUUID()}`,
    orderId,
    amountPaise: order.total_paise,
    status: 'captured' as const,
  };
  return processPaymentEvent(event, JSON.stringify({ ...event, source: 'dev-payment-simulator' }));
}

import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import { PG_LOCK_NOT_AVAILABLE, PG_UNIQUE_VIOLATION, isPgError, rollback } from '../db/transaction.js';
import { AppError } from '../errors/AppError.js';
import type { PaymentWebhookPayload } from '../schemas/payments.schema.js';
import { LOCK_TIMEOUT, type OrderStatus } from './orders.service.js';

export type PaymentOutcome =
  | 'paid'
  | 'late_payment'
  | 'amount_mismatch'
  | 'already_paid'
  | 'order_not_payable'
  | 'payment_failed';

export type PaymentEventResult = {
  eventId: string;
  orderId: string;
  outcome: PaymentOutcome;
  /** The order's status after this event (unchanged for duplicates). */
  orderStatus: OrderStatus;
  /** True when this eventId had already been processed; nothing was applied. */
  duplicate: boolean;
};

type Decision = {
  outcome: PaymentOutcome;
  detail: string | null;
  newStatus: 'paid' | 'needs_review' | null;
};

type StoredEvent = {
  order_id: string;
  amount_paise: number;
  status: string;
  outcome: PaymentOutcome;
};

/**
 * Applies one signed payment event, exactly once.
 *
 * Inside a single transaction:
 *  1. Lock the order row (FOR UPDATE). Concurrent events for the same order
 *     queue here.
 *  2. Look the eventId up. A duplicate that arrived concurrently has committed
 *     by the time we hold the lock, so it is found and acknowledged without
 *     re-applying anything.
 *  3. If the order could become paid, also lock its product rows in id order,
 *     the same locks order creation takes. This serialises the deadline
 *     decision with competing order creation, so a payment can never be judged
 *     "in time" while a new order is concurrently taking the released units.
 *  4. Take the decision time (clock_timestamp(), i.e. after all locks were
 *     acquired) and compare it with expires_at.
 *  5. Insert the event (UNIQUE event_id) and apply the status change, then
 *     COMMIT. Any failure rolls back both.
 *
 * Payment never changes products.stock_quantity; that happens at collection.
 */
export async function processPaymentEvent(
  event: PaymentWebhookPayload,
  rawPayload: string,
): Promise<PaymentEventResult> {
  const client = await pool.connect();
  let clientBroken = false;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);

    // 1. Lock the order.
    const orderResult = await client.query<{ status: OrderStatus; total_paise: number }>(
      `/* payment:lock-order */
       SELECT status, total_paise FROM orders WHERE id = $1 FOR UPDATE`,
      [event.orderId],
    );
    const order = orderResult.rows[0];
    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
    }

    // 2. Idempotency: has this event already been processed?
    const existing = await findStoredEvent(client, event.eventId);
    if (existing) {
      await client.query('ROLLBACK');
      return duplicateResult(existing, event, order.status);
    }

    // 3. Serialise with order creation for this order's products.
    const mayBecomePaid = event.status === 'captured' && order.status === 'pending';
    if (mayBecomePaid) {
      await client.query(
        `/* payment:lock-products */
         SELECT p.id
           FROM products p
          WHERE p.id IN (SELECT product_id FROM order_items WHERE order_id = $1)
          ORDER BY p.id
            FOR UPDATE`,
        [event.orderId],
      );
    }

    // 4. Decide, using database time taken while holding the locks.
    const timing = await client.query<{ decided_at: Date; in_time: boolean }>(
      `SELECT c.t AS decided_at, o.expires_at > c.t AS in_time
         FROM orders o
        CROSS JOIN (SELECT clock_timestamp() AS t) c
        WHERE o.id = $1`,
      [event.orderId],
    );
    const clock = timing.rows[0];
    if (!clock) throw new Error('Locked order disappeared');
    const { decided_at: decidedAt, in_time: inTime } = clock;
    const decision = decide(event, order, inTime);

    // 5. Record the event and apply its effect atomically.
    await client.query(
      `INSERT INTO payment_events (event_id, order_id, amount_paise, status, outcome, detail, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [event.eventId, event.orderId, event.amountPaise, event.status, decision.outcome, decision.detail, rawPayload],
    );

    if (decision.newStatus === 'paid') {
      const updated = await client.query(
        `UPDATE orders SET status = 'paid', paid_at = $2
          WHERE id = $1 AND status = 'pending'`,
        [event.orderId, decidedAt],
      );
      if (updated.rowCount !== 1) throw new Error('Order changed state while locked');
    } else if (decision.newStatus === 'needs_review') {
      // A late payment also records when the reservation lapsed, if not yet stored.
      const updated = await client.query(
        `UPDATE orders
            SET status = 'needs_review',
                expired_at = CASE WHEN expires_at <= $2 THEN COALESCE(expired_at, $2) ELSE expired_at END
          WHERE id = $1 AND status IN ('pending', 'expired')`,
        [event.orderId, decidedAt],
      );
      if (updated.rowCount !== 1) throw new Error('Order changed state while locked');
    }

    await client.query('COMMIT');
    return {
      eventId: event.eventId,
      orderId: event.orderId,
      outcome: decision.outcome,
      orderStatus: decision.newStatus ?? order.status,
      duplicate: false,
    };
  } catch (err) {
    clientBroken = !(await rollback(client));

    // Same eventId inserted concurrently by a request for a *different* order
    // (requests for the same order are serialised by the order lock above).
    if (isPgError(err) && err.code === PG_UNIQUE_VIOLATION && err.constraint === 'payment_events_event_id_unique') {
      const stored = await findStoredEvent(pool, event.eventId);
      if (stored) {
        const status = await pool.query<{ status: OrderStatus }>('SELECT status FROM orders WHERE id = $1', [
          stored.order_id,
        ]);
        return duplicateResult(stored, event, status.rows[0]?.status ?? 'pending');
      }
    }
    if (isPgError(err) && err.code === PG_LOCK_NOT_AVAILABLE) {
      throw new AppError(503, 'PAYMENT_BUSY', 'The order is busy. Please retry the webhook.');
    }
    throw err;
  } finally {
    client.release(clientBroken);
  }
}

function decide(
  event: PaymentWebhookPayload,
  order: { status: OrderStatus; total_paise: number },
  inTime: boolean,
): Decision {
  if (event.status === 'failed') {
    return { outcome: 'payment_failed', detail: 'Provider reported a failed payment.', newStatus: null };
  }

  const mismatch =
    event.amountPaise === order.total_paise
      ? null
      : `Paid ${event.amountPaise} paise; order total is ${order.total_paise} paise.`;
  const late = (): Decision => ({
    outcome: 'late_payment',
    detail: ['Payment captured after the reservation expired; stock was not re-reserved.', mismatch]
      .filter(Boolean)
      .join(' '),
    newStatus: 'needs_review',
  });

  switch (order.status) {
    case 'pending':
      if (!inTime) return late();
      if (mismatch) return { outcome: 'amount_mismatch', detail: mismatch, newStatus: 'needs_review' };
      return { outcome: 'paid', detail: null, newStatus: 'paid' };
    case 'expired':
      return late();
    case 'paid':
      return {
        outcome: 'already_paid',
        detail: 'Order was already paid by an earlier event; no change applied.',
        newStatus: null,
      };
    case 'needs_review':
    case 'collected':
      return { outcome: 'order_not_payable', detail: `Order is ${order.status}; no change applied.`, newStatus: null };
  }
}

async function findStoredEvent(db: Pick<PoolClient, 'query'>, eventId: string): Promise<StoredEvent | null> {
  const { rows } = await db.query<StoredEvent>(
    'SELECT order_id, amount_paise, status, outcome FROM payment_events WHERE event_id = $1',
    [eventId],
  );
  return rows[0] ?? null;
}

/** Acknowledges a re-delivered event, or rejects an eventId reused for a different payment. */
function duplicateResult(
  stored: StoredEvent,
  event: PaymentWebhookPayload,
  orderStatus: OrderStatus,
): PaymentEventResult {
  const samePayment =
    stored.order_id === event.orderId && stored.amount_paise === event.amountPaise && stored.status === event.status;
  if (!samePayment) {
    throw new AppError(409, 'EVENT_ID_CONFLICT', 'This eventId was already used for a different payment.');
  }
  return { eventId: event.eventId, orderId: event.orderId, outcome: stored.outcome, orderStatus, duplicate: true };
}

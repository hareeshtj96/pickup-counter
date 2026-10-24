import { pool } from '../db/pool.js';
import { PG_LOCK_NOT_AVAILABLE, isPgError, rollback } from '../db/transaction.js';
import { AppError } from '../errors/AppError.js';

/** How long a new, unpaid order holds its stock. */
export const RESERVATION_SECONDS = 120;
/** Request limits (documented in the README). */
export const MAX_LINE_ITEMS = 20;
export const MAX_QUANTITY_PER_ITEM = 20;
/** orders.total_paise is a PostgreSQL INTEGER. */
const MAX_TOTAL_PAISE = 2_147_483_647;
/** Give up instead of queueing forever if product rows stay locked. */
export const LOCK_TIMEOUT = '5s';

export type OrderStatus = 'pending' | 'paid' | 'expired' | 'needs_review' | 'collected';

export type OrderItemInput = { productId: string; quantity: number };

export type OrderItem = {
  productId: string;
  name: string;
  quantity: number;
  unitPricePaise: number;
  lineTotalPaise: number;
};

export type Order = {
  id: string;
  status: OrderStatus;
  totalPaise: number;
  createdAt: string;
  expiresAt: string;
  /**
   * Seconds left on the reservation, from database time at response time.
   * 0 once expired; null when the deadline no longer applies (paid,
   * needs_review, collected).
   */
  expiresInSeconds: number | null;
  items: OrderItem[];
};

/**
 * Creates an order and reserves its stock atomically.
 *
 * Concurrency: the requested product rows are locked with FOR UPDATE in id
 * order (a consistent order avoids deadlocks between two multi-product orders).
 * Every transaction that adds reservations for a product holds that product's
 * row lock until it commits. So when we obtain the lock, any earlier competing
 * order has already committed or rolled back, and the availability query that
 * follows (a new statement, so a fresh READ COMMITTED snapshot) sees its
 * reserved units. Two transactions can therefore never both claim the last unit.
 */
export async function createOrder(items: OrderItemInput[]): Promise<Order> {
  const productIds = items.map((item) => item.productId);
  let orderId: string;

  const client = await pool.connect();
  let clientBroken = false;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);

    // 1. Lock the requested products, in a consistent order.
    const locked = await client.query<{ id: string; price_paise: number }>(
      `SELECT id, price_paise
         FROM products
        WHERE id = ANY($1::uuid[])
        ORDER BY id
          FOR UPDATE`,
      [productIds],
    );
    const priceById = new Map(locked.rows.map((row) => [row.id, row.price_paise]));

    const unknown = productIds.filter((id) => !priceById.has(id));
    if (unknown.length > 0) {
      throw new AppError(422, 'UNKNOWN_PRODUCT', 'One or more products do not exist.', {
        productIds: unknown,
      });
    }

    // 2. Recalculate availability now that we hold the locks.
    const availability = await client.query<{ product_id: string; available_units: number }>(
      `SELECT product_id, available_units
         FROM product_availability
        WHERE product_id = ANY($1::uuid[])`,
      [productIds],
    );
    const availableById = new Map(
      availability.rows.map((row) => [row.product_id, row.available_units]),
    );

    const shortages = items
      .map((item) => ({
        productId: item.productId,
        requested: item.quantity,
        available: availableById.get(item.productId) ?? 0,
      }))
      .filter((line) => line.available < line.requested);
    if (shortages.length > 0) {
      throw new AppError(409, 'INSUFFICIENT_STOCK', 'Not enough stock for one or more items.', shortages);
    }

    // 3. Price the order from the locked rows, never from the client.
    const lines = items.map((item) => ({ ...item, unitPricePaise: priceById.get(item.productId) ?? 0 }));
    const totalPaise = lines.reduce((sum, line) => sum + line.unitPricePaise * line.quantity, 0);
    if (!Number.isSafeInteger(totalPaise) || totalPaise > MAX_TOTAL_PAISE) {
      throw new AppError(422, 'ORDER_TOTAL_TOO_LARGE', 'The order total is too large.');
    }

    // 4. Create the order and its items; the deadline comes from database time.
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO orders (status, total_paise, expires_at)
       VALUES ('pending', $1, now() + make_interval(secs => $2))
       RETURNING id`,
      [totalPaise, RESERVATION_SECONDS],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error('Order insert returned no id');
    orderId = id;

    await client.query(
      `INSERT INTO order_items (order_id, product_id, quantity, unit_price_paise)
       SELECT $1, product_id, quantity, unit_price_paise
         FROM unnest($2::uuid[], $3::int[], $4::int[]) AS l(product_id, quantity, unit_price_paise)`,
      [
        orderId,
        lines.map((line) => line.productId),
        lines.map((line) => line.quantity),
        lines.map((line) => line.unitPricePaise),
      ],
    );

    await client.query('COMMIT');
  } catch (err) {
    clientBroken = !(await rollback(client));
    if (isPgError(err) && err.code === PG_LOCK_NOT_AVAILABLE) {
      throw new AppError(503, 'RESERVATION_BUSY', 'The counter is busy. Please try again.');
    }
    throw err;
  } finally {
    // A client whose rollback failed is discarded instead of reused.
    client.release(clientBroken);
  }

  const order = await getOrder(orderId);
  if (!order) throw new Error(`Order ${orderId} not found after commit`);
  return order;
}

/**
 * Returns an order with its effective status, or null if it does not exist.
 *
 * An unpaid order past its deadline is reported as expired even if nothing has
 * persisted that yet; the conditional UPDATE persists it and can never touch an
 * order that is no longer pending (e.g. already paid).
 */
export async function getOrder(id: string): Promise<Order | null> {
  await pool.query(
    `UPDATE orders
        SET status = 'expired', expired_at = now()
      WHERE id = $1 AND status = 'pending' AND expires_at <= now()`,
    [id],
  );

  const { rows } = await pool.query<OrderRow>(
    `SELECT id,
            CASE WHEN status = 'pending' AND expires_at <= now() THEN 'expired' ELSE status END AS status,
            total_paise,
            created_at,
            expires_at,
            CASE
              WHEN status = 'pending' AND expires_at > now()
                THEN FLOOR(EXTRACT(EPOCH FROM (expires_at - now())))::integer
              WHEN status IN ('pending', 'expired') THEN 0
              ELSE NULL
            END AS expires_in_seconds
       FROM orders
      WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;

  const items = await pool.query<OrderItemRow>(
    `SELECT oi.product_id, p.name, oi.quantity, oi.unit_price_paise
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1
      ORDER BY p.name, oi.product_id`,
    [id],
  );

  return {
    id: row.id,
    status: row.status,
    totalPaise: row.total_paise,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    expiresInSeconds: row.expires_in_seconds,
    items: items.rows.map((item) => ({
      productId: item.product_id,
      name: item.name,
      quantity: item.quantity,
      unitPricePaise: item.unit_price_paise,
      lineTotalPaise: item.quantity * item.unit_price_paise,
    })),
  };
}

/**
 * Persists 'expired' for every unpaid order past its deadline. Only pending
 * orders are touched, so a paid order is never overwritten. Stock availability
 * does not depend on this running: expired reservations are already excluded
 * by the expires_at check in product_availability.
 */
export async function expireOverdueOrders(): Promise<number> {
  const result = await pool.query(
    `UPDATE orders
        SET status = 'expired', expired_at = now()
      WHERE status = 'pending' AND expires_at <= now()`,
  );
  return result.rowCount ?? 0;
}

export type CollectResult = Order & {
  /** True when the order had already been collected; nothing was changed. */
  alreadyCollected: boolean;
};

/**
 * Staff confirm pickup: moves a paid order to 'collected' and deducts its
 * quantities from physical stock, exactly once, in one transaction.
 *
 *  1. Lock the order row. Concurrent collections of the same order (and any
 *     payment for it) queue here.
 *  2. Re-check the status under the lock: already collected -> acknowledge
 *     without touching stock; anything other than paid -> 409.
 *  3. Lock the order's product rows in id order, the same order used by order
 *     creation and payment, so lock acquisition can never form a cycle.
 *  4. Verify physical stock covers every item.
 *  5. Deduct with a guarded UPDATE and check the affected row count.
 *  6. Mark the order collected (guarded on status = 'paid').
 *  7. COMMIT. Any failure rolls back stock and status together.
 *
 * Availability is unchanged by collection: the units stop counting as a paid
 * reservation in product_availability at the same moment they leave
 * stock_quantity.
 */
export async function collectOrder(id: string): Promise<CollectResult> {
  const client = await pool.connect();
  let clientBroken = false;
  let alreadyCollected = false;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);

    // 1. Lock the order.
    const orderResult = await client.query<{ status: OrderStatus; overdue: boolean }>(
      `/* collect:lock-order */
       SELECT status, expires_at <= now() AS overdue FROM orders WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const order = orderResult.rows[0];
    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
    }

    // 2. Decide from the status read under the lock.
    if (order.status === 'collected') {
      alreadyCollected = true;
      await client.query('ROLLBACK');
    } else {
      if (order.status !== 'paid') {
        const status = order.status === 'pending' && order.overdue ? 'expired' : order.status;
        throw new AppError(409, 'ORDER_NOT_COLLECTABLE', `Only paid orders can be collected; this order is ${status}.`, {
          status,
        });
      }

      // 3. Lock the products, in the shared deterministic order.
      const items = await client.query<{ product_id: string; stock_quantity: number; quantity: number }>(
        `/* collect:lock-products */
         SELECT p.id AS product_id, p.stock_quantity, oi.quantity
           FROM order_items oi
           JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id = $1
          ORDER BY p.id
            FOR UPDATE OF p`,
        [id],
      );

      // 4. Physical stock must cover every item.
      const shortages = items.rows
        .filter((item) => item.stock_quantity < item.quantity)
        .map((item) => ({ productId: item.product_id, required: item.quantity, inStock: item.stock_quantity }));
      if (shortages.length > 0) {
        throw new AppError(
          409,
          'INSUFFICIENT_PHYSICAL_STOCK',
          'Not enough physical stock to hand over this order.',
          shortages,
        );
      }

      // 5. Deduct, guarded so stock can never go below zero.
      const deducted = await client.query(
        `UPDATE products p
            SET stock_quantity = p.stock_quantity - oi.quantity
           FROM order_items oi
          WHERE oi.order_id = $1
            AND oi.product_id = p.id
            AND p.stock_quantity >= oi.quantity`,
        [id],
      );
      if (items.rows.length === 0 || deducted.rowCount !== items.rows.length) {
        throw new Error('Stock deduction did not cover every order item');
      }

      // 6. Paid -> collected.
      const collected = await client.query(
        `UPDATE orders SET status = 'collected', collected_at = clock_timestamp()
          WHERE id = $1 AND status = 'paid'`,
        [id],
      );
      if (collected.rowCount !== 1) throw new Error('Order changed state while locked');

      await client.query('COMMIT');
    }
  } catch (err) {
    clientBroken = !(await rollback(client));
    if (isPgError(err) && err.code === PG_LOCK_NOT_AVAILABLE) {
      throw new AppError(503, 'COLLECTION_BUSY', 'The order is busy. Please try again.');
    }
    throw err;
  } finally {
    client.release(clientBroken);
  }

  const result = await getOrder(id);
  if (!result) throw new Error(`Order ${id} not found after collection`);
  return { ...result, alreadyCollected };
}

type OrderRow = {
  id: string;
  status: OrderStatus;
  total_paise: number;
  created_at: Date;
  expires_at: Date;
  expires_in_seconds: number | null;
};

type OrderItemRow = {
  product_id: string;
  name: string;
  quantity: number;
  unit_price_paise: number;
};

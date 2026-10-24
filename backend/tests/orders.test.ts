import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { MAX_LINE_ITEMS, MAX_QUANTITY_PER_ITEM, expireOverdueOrders } from '../src/services/orders.service.js';
import { resetDomainTables, resolveTestDatabaseConfig } from './helpers/testDatabase.js';

const app = createApp();
const testDatabaseUrl = resolveTestDatabaseConfig(process.env).url;

type OrderResponse = {
  id: string;
  status: string;
  totalPaise: number;
  createdAt: string;
  expiresAt: string;
  expiresInSeconds: number | null;
  items: { productId: string; name: string; quantity: number; unitPricePaise: number; lineTotalPaise: number }[];
};
type ErrorResponse = { error: { code: string; message: string; details?: unknown } };
type ProductsResponse = { products: { id: string; availableUnits: number; pricePaise: number }[] };

// ---------- fixtures (all on the verified test database) ----------

async function createProduct(name: string, pricePaise: number, stockQuantity: number): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO products (name, price_paise, stock_quantity) VALUES ($1, $2, $3) RETURNING id',
    [name, pricePaise, stockQuantity],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('fixture insert failed');
  return id;
}

async function placeOrder(items: { productId: string; quantity: number }[]) {
  return request(app).post('/orders').send({ items });
}

async function placeOrderOk(items: { productId: string; quantity: number }[]): Promise<OrderResponse> {
  const res = await placeOrder(items);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as OrderResponse;
}

/** Available units as the public catalog reports them. */
async function availableUnits(productId: string): Promise<number | undefined> {
  const res = await request(app).get('/products');
  return (res.body as ProductsResponse).products.find((p) => p.id === productId)?.availableUnits;
}

async function stockRow(productId: string) {
  const { rows } = await pool.query<{ stock_quantity: number; reserved_units: number; available_units: number }>(
    'SELECT stock_quantity, reserved_units, available_units FROM product_availability WHERE product_id = $1',
    [productId],
  );
  return rows[0];
}

async function storedStatus(orderId: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [orderId]);
  return rows[0]?.status;
}

async function countOrders(): Promise<{ orders: number; items: number }> {
  const { rows } = await pool.query<{ orders: number; items: number }>(
    'SELECT (SELECT count(*)::int FROM orders) AS orders, (SELECT count(*)::int FROM order_items) AS items',
  );
  return rows[0] ?? { orders: -1, items: -1 };
}

/** Moves an order's reservation deadline into the past (simulates 120 s passing). */
async function expireReservation(orderId: string): Promise<void> {
  await pool.query(
    `UPDATE orders
        SET created_at = now() - interval '200 seconds',
            expires_at = now() - interval '1 second'
      WHERE id = $1`,
    [orderId],
  );
}

/** What a successful payment will do (Phase 4); set directly here. */
async function markPaid(orderId: string): Promise<void> {
  await pool.query("UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1", [orderId]);
}

/** What a successful pickup will do (later phase): decrement stock and collect, atomically. */
async function markCollected(orderId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE products p
          SET stock_quantity = p.stock_quantity - oi.quantity
         FROM order_items oi
        WHERE oi.order_id = $1 AND oi.product_id = p.id`,
      [orderId],
    );
    await client.query("UPDATE orders SET status = 'collected', collected_at = now() WHERE id = $1", [orderId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

beforeEach(async () => {
  await resetDomainTables(pool);
});

// ---------- tests ----------

describe('POST /orders: success', () => {
  it('creates a pending order with an integer-paise total and price snapshots', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const puff = await createProduct('Paneer Puff', 3500, 5);

    const res = await placeOrder([
      { productId: samosa, quantity: 2 },
      { productId: puff, quantity: 3 },
    ]);
    const order = res.body as OrderResponse;

    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/orders/${order.id}`);
    expect(order.status).toBe('pending');
    expect(order.totalPaise).toBe(2 * 2000 + 3 * 3500);
    expect(Number.isInteger(order.totalPaise)).toBe(true);
    expect(order.items).toEqual([
      { productId: puff, name: 'Paneer Puff', quantity: 3, unitPricePaise: 3500, lineTotalPaise: 10500 },
      { productId: samosa, name: 'Samosa', quantity: 2, unitPricePaise: 2000, lineTotalPaise: 4000 },
    ]);

    const { rows } = await pool.query<{ product_id: string; unit_price_paise: number }>(
      'SELECT product_id, unit_price_paise FROM order_items WHERE order_id = $1 ORDER BY unit_price_paise',
      [order.id],
    );
    expect(rows).toEqual([
      { product_id: samosa, unit_price_paise: 2000 },
      { product_id: puff, unit_price_paise: 3500 },
    ]);
  });

  it('keeps the original unit prices and total after a product price change', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const order = await placeOrderOk([{ productId: samosa, quantity: 3 }]);

    await pool.query('UPDATE products SET price_paise = 9900 WHERE id = $1', [samosa]);

    const res = await request(app).get(`/orders/${order.id}`);
    const fetched = res.body as OrderResponse;
    expect(fetched.totalPaise).toBe(6000);
    expect(fetched.items[0]).toMatchObject({ unitPricePaise: 2000, lineTotalPaise: 6000 });

    // New orders use the new price.
    const next = await placeOrderOk([{ productId: samosa, quantity: 1 }]);
    expect(next.totalPaise).toBe(9900);
  });

  it('sets a 120-second reservation from database time and reports the remaining time', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const order = await placeOrderOk([{ productId: samosa, quantity: 1 }]);

    expect(order.expiresInSeconds).toBeGreaterThanOrEqual(115);
    expect(order.expiresInSeconds).toBeLessThanOrEqual(120);

    const { rows } = await pool.query<{ ttl: number }>(
      'SELECT EXTRACT(EPOCH FROM (expires_at - created_at))::int AS ttl FROM orders WHERE id = $1',
      [order.id],
    );
    expect(rows[0]?.ttl).toBe(120);
    expect(new Date(order.expiresAt).getTime() - new Date(order.createdAt).getTime()).toBe(120_000);
  });
});

describe('POST /orders: validation', () => {
  const validId = 'a1b2c3d4-0001-4000-8000-000000000001';

  it.each([
    ['empty body', {}],
    ['items not an array', { items: 'samosa' }],
    ['empty items', { items: [] }],
    ['missing productId', { items: [{ quantity: 1 }] }],
    ['invalid productId', { items: [{ productId: 'not-a-uuid', quantity: 1 }] }],
    ['missing quantity', { items: [{ productId: validId }] }],
    ['zero quantity', { items: [{ productId: validId, quantity: 0 }] }],
    ['negative quantity', { items: [{ productId: validId, quantity: -2 }] }],
    ['fractional quantity', { items: [{ productId: validId, quantity: 1.5 }] }],
    ['quantity as a string', { items: [{ productId: validId, quantity: '2' }] }],
    ['quantity above the limit', { items: [{ productId: validId, quantity: MAX_QUANTITY_PER_ITEM + 1 }] }],
    [
      'too many line items',
      {
        items: Array.from({ length: MAX_LINE_ITEMS + 1 }, (_, i) => ({
          productId: `a1b2c3d4-0001-4000-8000-${String(i).padStart(12, '0')}`,
          quantity: 1,
        })),
      },
    ],
    [
      'duplicate productId',
      { items: [{ productId: validId, quantity: 1 }, { productId: validId, quantity: 2 }] },
    ],
    ['client-supplied price', { items: [{ productId: validId, quantity: 1, pricePaise: 1 }] }],
    ['unknown top-level field', { items: [{ productId: validId, quantity: 1 }], total: 1 }],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await request(app).post('/orders').send(body);
    expect(res.status).toBe(400);
    expect((res.body as ErrorResponse).error.code).toBe('VALIDATION_ERROR');
    expect(await countOrders()).toEqual({ orders: 0, items: 0 });
  });

  it('explains duplicate products clearly', async () => {
    const res = await request(app)
      .post('/orders')
      .send({ items: [{ productId: validId, quantity: 1 }, { productId: validId, quantity: 2 }] });
    expect((res.body as ErrorResponse).error.details).toEqual([
      { path: 'body.items.1.productId', message: 'Each product may appear only once; combine the quantities instead' },
    ]);
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await request(app).post('/orders').set('Content-Type', 'application/json').send('{"items":[');
    expect(res.status).toBe(400);
    expect((res.body as ErrorResponse).error.code).toBe('INVALID_JSON');
  });
});

describe('POST /orders: business rules', () => {
  it('rejects unknown product IDs with 422 and creates nothing', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const missing = 'a1b2c3d4-9999-4000-8000-000000000999';

    const res = await placeOrder([
      { productId: samosa, quantity: 1 },
      { productId: missing, quantity: 1 },
    ]);

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: {
        code: 'UNKNOWN_PRODUCT',
        message: 'One or more products do not exist.',
        details: { productIds: [missing] },
      },
    });
    expect(await countOrders()).toEqual({ orders: 0, items: 0 });
  });

  it('rejects insufficient stock with 409 and the available quantity', async () => {
    const brownie = await createProduct('Chocolate Brownie', 6000, 3);

    const res = await placeOrder([{ productId: brownie, quantity: 4 }]);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: 'INSUFFICIENT_STOCK',
        message: 'Not enough stock for one or more items.',
        details: [{ productId: brownie, requested: 4, available: 3 }],
      },
    });
    expect(await countOrders()).toEqual({ orders: 0, items: 0 });
  });

  it('rolls back the whole order when one item is unavailable', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const brownie = await createProduct('Chocolate Brownie', 6000, 1);

    const res = await placeOrder([
      { productId: samosa, quantity: 5 },
      { productId: brownie, quantity: 2 },
    ]);

    expect(res.status).toBe(409);
    expect((res.body as ErrorResponse).error.details).toEqual([
      { productId: brownie, requested: 2, available: 1 },
    ]);
    expect(await countOrders()).toEqual({ orders: 0, items: 0 });
    expect(await availableUnits(samosa)).toBe(10);
    expect(await availableUnits(brownie)).toBe(1);
  });

  it('rejects a total that does not fit in integer paise', async () => {
    const gold = await createProduct('Gold Ladoo', 2_000_000_000, 5);

    const res = await placeOrder([{ productId: gold, quantity: 2 }]);

    expect(res.status).toBe(422);
    expect((res.body as ErrorResponse).error.code).toBe('ORDER_TOTAL_TOO_LARGE');
    expect(await countOrders()).toEqual({ orders: 0, items: 0 });
  });
});

describe('stock availability', () => {
  it('subtracts active unpaid reservations without touching physical stock', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    await placeOrderOk([{ productId: samosa, quantity: 3 }]);

    expect(await availableUnits(samosa)).toBe(7);
    expect(await stockRow(samosa)).toEqual({ stock_quantity: 10, reserved_units: 3, available_units: 7 });

    // The next customer can only take what is left.
    const res = await placeOrder([{ productId: samosa, quantity: 8 }]);
    expect(res.status).toBe(409);
  });

  it('releases stock as soon as a reservation expires, before any status update', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const order = await placeOrderOk([{ productId: samosa, quantity: 3 }]);

    await expireReservation(order.id);

    expect(await storedStatus(order.id)).toBe('pending'); // nothing has persisted 'expired' yet
    expect(await availableUnits(samosa)).toBe(10);
    await placeOrderOk([{ productId: samosa, quantity: 10 }]);
  });

  it('keeps paid, uncollected orders reserved even after the original deadline', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const order = await placeOrderOk([{ productId: samosa, quantity: 3 }]);
    await markPaid(order.id);
    await expireReservation(order.id);

    expect(await availableUnits(samosa)).toBe(7);
    expect(await stockRow(samosa)).toEqual({ stock_quantity: 10, reserved_units: 3, available_units: 7 });
  });

  it('does not count collected orders twice once physical stock is reduced', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const order = await placeOrderOk([{ productId: samosa, quantity: 3 }]);
    await markPaid(order.id);
    await markCollected(order.id);

    expect(await stockRow(samosa)).toEqual({ stock_quantity: 7, reserved_units: 0, available_units: 7 });
    expect(await availableUnits(samosa)).toBe(7);
  });

  it('does not reserve stock for expired or needs_review orders', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const expired = await placeOrderOk([{ productId: samosa, quantity: 2 }]);
    const review = await placeOrderOk([{ productId: samosa, quantity: 3 }]);
    await expireReservation(expired.id);
    await pool.query(
      "UPDATE orders SET status = 'expired', expired_at = now() WHERE id = $1",
      [expired.id],
    );
    await pool.query("UPDATE orders SET status = 'needs_review' WHERE id = $1", [review.id]);

    expect(await availableUnits(samosa)).toBe(10);
  });

  it('never reports negative availability or lets physical stock go negative', async () => {
    const samosa = await createProduct('Samosa', 2000, 2);
    await placeOrderOk([{ productId: samosa, quantity: 2 }]);

    // Staff write off a unit that was already reserved: availability floors at 0.
    await pool.query('UPDATE products SET stock_quantity = 1 WHERE id = $1', [samosa]);
    expect(await availableUnits(samosa)).toBe(0);

    await expect(
      pool.query('UPDATE products SET stock_quantity = stock_quantity - 5 WHERE id = $1', [samosa]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('GET /orders/:id', () => {
  it('reports a pending order with its remaining time', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const order = await placeOrderOk([{ productId: samosa, quantity: 1 }]);
    await pool.query("UPDATE orders SET expires_at = now() + interval '30 seconds' WHERE id = $1", [order.id]);

    const res = await request(app).get(`/api/orders/${order.id}`);
    const fetched = res.body as OrderResponse;

    expect(res.status).toBe(200);
    expect(fetched).toMatchObject({ id: order.id, status: 'pending', totalPaise: 2000 });
    expect(fetched.expiresInSeconds).toBeGreaterThanOrEqual(28);
    expect(fetched.expiresInSeconds).toBeLessThanOrEqual(30);
  });

  it('reports an overdue order as expired and persists it, without a worker', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const order = await placeOrderOk([{ productId: samosa, quantity: 1 }]);
    await expireReservation(order.id);
    expect(await storedStatus(order.id)).toBe('pending');

    const res = await request(app).get(`/orders/${order.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'expired', expiresInSeconds: 0 });
    expect(await storedStatus(order.id)).toBe('expired');
  });

  it('never turns a paid order into expired', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const order = await placeOrderOk([{ productId: samosa, quantity: 1 }]);
    await markPaid(order.id);
    await expireReservation(order.id);

    const res = await request(app).get(`/orders/${order.id}`);

    expect(res.body).toMatchObject({ status: 'paid', expiresInSeconds: null });
    expect(await storedStatus(order.id)).toBe('paid');
  });

  it('returns 404 for an unknown order and 400 for a malformed id', async () => {
    const missing = await request(app).get('/orders/a1b2c3d4-9999-4000-8000-000000000999');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: { code: 'ORDER_NOT_FOUND', message: 'Order not found.' } });

    const malformed = await request(app).get('/orders/12345');
    expect(malformed.status).toBe(400);
    expect((malformed.body as ErrorResponse).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('expiry sweep', () => {
  it('persists expired only for overdue pending orders', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const overdue = await placeOrderOk([{ productId: samosa, quantity: 1 }]);
    const active = await placeOrderOk([{ productId: samosa, quantity: 1 }]);
    const paidLate = await placeOrderOk([{ productId: samosa, quantity: 1 }]);
    await expireReservation(overdue.id);
    await markPaid(paidLate.id);
    await expireReservation(paidLate.id);

    expect(await expireOverdueOrders()).toBe(1);

    expect(await storedStatus(overdue.id)).toBe('expired');
    expect(await storedStatus(active.id)).toBe('pending');
    expect(await storedStatus(paidLate.id)).toBe('paid');
    expect(await expireOverdueOrders()).toBe(0);
  });
});

describe('concurrency (real overlapping transactions)', () => {
  let server: http.Server;
  let baseUrl: string;
  let gate: pg.Client;

  beforeAll(async () => {
    // One real HTTP server shared by all simultaneous requests.
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  /** Order transactions currently blocked waiting for a row lock. */
  async function blockedOrderTransactions(): Promise<number> {
    const { rows } = await pool.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query LIKE '%FOR UPDATE%'`,
    );
    return rows[0]?.waiting ?? 0;
  }

  async function waitUntil(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Holds the product row lock so every request reaches the database and
   * queues on it; once all of them are provably waiting at the same time, the
   * gate is released and they race for real.
   */
  async function closeGate(productId: string): Promise<void> {
    gate = new pg.Client({ connectionString: testDatabaseUrl });
    await gate.connect();
    await gate.query('BEGIN');
    await gate.query('SELECT 1 FROM products WHERE id = $1 FOR UPDATE', [productId]);
  }

  async function openGate(): Promise<void> {
    await gate.query('COMMIT');
    await gate.end();
  }

  it('ten customers racing for the last two units: exactly two succeed', async () => {
    const samosa = await createProduct('Last Samosas', 2000, 2);
    await closeGate(samosa);

    const responses = Array.from({ length: 10 }, () =>
      request(baseUrl)
        .post('/orders')
        .send({ items: [{ productId: samosa, quantity: 1 }] })
        .then((res) => res),
    );

    // Prove the requests genuinely overlap: all ten transactions are inside
    // PostgreSQL at the same moment, blocked on the same row.
    await waitUntil(async () => (await blockedOrderTransactions()) === 10, 4_000);
    await openGate();

    const results = await Promise.all(responses);
    const statuses = results.map((res) => res.status).sort();

    expect(statuses).toEqual([201, 201, 409, 409, 409, 409, 409, 409, 409, 409]);
    for (const res of results.filter((r) => r.status === 409)) {
      expect((res.body as ErrorResponse).error.code).toBe('INSUFFICIENT_STOCK');
    }

    expect(await stockRow(samosa)).toEqual({ stock_quantity: 2, reserved_units: 2, available_units: 0 });
    const { rows } = await pool.query<{ orders: number; units: number; orphans: number }>(
      `SELECT (SELECT count(*)::int FROM orders) AS orders,
              (SELECT COALESCE(SUM(quantity), 0)::int FROM order_items) AS units,
              (SELECT count(*)::int FROM orders o
                WHERE NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id)) AS orphans`,
    );
    expect(rows[0]).toEqual({ orders: 2, units: 2, orphans: 0 });
  });

  it('multi-product orders locking in opposite request order do not deadlock or oversell', async () => {
    const a = await createProduct('Product A', 1000, 3);
    const b = await createProduct('Product B', 1000, 3);

    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(baseUrl)
          .post('/orders')
          .send({
            items:
              i % 2 === 0
                ? [{ productId: a, quantity: 1 }, { productId: b, quantity: 1 }]
                : [{ productId: b, quantity: 1 }, { productId: a, quantity: 1 }],
          })
          .then((res) => res),
      ),
    );

    const statuses = responses.map((res) => res.status).sort();
    expect(statuses).toEqual([201, 201, 201, 409, 409, 409, 409, 409]);
    expect(await stockRow(a)).toEqual({ stock_quantity: 3, reserved_units: 3, available_units: 0 });
    expect(await stockRow(b)).toEqual({ stock_quantity: 3, reserved_units: 3, available_units: 0 });
  });

  it('gives up with 503 instead of waiting forever on a stuck lock, leaving nothing behind', async () => {
    const samosa = await createProduct('Samosa', 2000, 5);
    await closeGate(samosa);
    try {
      const res = await request(baseUrl)
        .post('/orders')
        .send({ items: [{ productId: samosa, quantity: 1 }] });
      expect(res.status).toBe(503);
      expect((res.body as ErrorResponse).error.code).toBe('RESERVATION_BUSY');
    } finally {
      await openGate();
    }
    expect(await countOrders()).toEqual({ orders: 0, items: 0 });
  });

  it('reports a deadlock as a retryable 503 without database details, leaving nothing behind', async () => {
    const [low, high] = [await createProduct('Product A', 1000, 5), await createProduct('Product B', 1000, 5)].sort();
    // Another session holds `high`; the order locks `low` (id order) and then waits for `high`.
    const other = new pg.Client({ connectionString: testDatabaseUrl });
    await other.connect();
    await other.query('BEGIN');
    // PostgreSQL aborts whichever deadlocked session's deadlock_timeout check runs
    // first (1 s by default, started when that session begins to wait). That is a
    // race: under load, this test's session was sometimes chosen as the victim, its
    // locks were released at once, and the order then succeeded (201). Delaying this
    // session's check makes the order's transaction the only one that can detect the
    // cycle in time, without changing what is tested. (deadlock_timeout needs a
    // superuser, which the Compose database user is.)
    await other.query("SET LOCAL deadlock_timeout = '30s'");
    await other.query('SELECT 1 FROM products WHERE id = $1 FOR UPDATE', [high]);
    try {
      const startedAt = Date.now();
      const pending = request(baseUrl)
        .post('/orders')
        .send({ items: [{ productId: low, quantity: 1 }, { productId: high, quantity: 1 }] })
        .then((res) => res);
      await waitUntil(async () => (await blockedOrderTransactions()) === 1, 4_000);

      // Close the cycle: this session now waits for `low`, which the order holds.
      // The result is captured instead of left as a bare promise, so a deadlock
      // error on this session fails the test with a clear message.
      const otherWaits = other
        .query('SELECT 1 FROM products WHERE id = $1 FOR UPDATE', [low])
        .then(
          () => 'granted',
          (err: { code?: string }) => `error ${err.code ?? 'unknown'}`,
        );
      const res = await pending;
      const elapsedMs = Date.now() - startedAt;

      // Granted only once the aborted order transaction released `low`.
      expect(await otherWaits).toBe('granted');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        error: { code: 'RESERVATION_BUSY', message: 'The counter is busy. Please try again.' },
      });
      expect(res.text).not.toMatch(/deadlock|40P01/i);
      // The order's lock_timeout is 5 s, so a response sooner than that cannot be a
      // lock timeout: it proves the 503 came from PostgreSQL's deadlock detection.
      expect(elapsedMs).toBeLessThan(5_000);
    } finally {
      await other.query('ROLLBACK').catch(() => undefined);
      await other.end();
    }
    expect(await countOrders()).toEqual({ orders: 0, items: 0 });
  });
});

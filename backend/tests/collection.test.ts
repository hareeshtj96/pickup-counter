import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { resetDomainTables, resolveTestDatabaseConfig } from './helpers/testDatabase.js';

const app = createApp();
const testDatabaseUrl = resolveTestDatabaseConfig(process.env).url;
const SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? '';

type CollectResponse = {
  id: string;
  status: string;
  totalPaise: number;
  expiresInSeconds: number | null;
  items: { productId: string; quantity: number }[];
  alreadyCollected: boolean;
};
type ErrorResponse = { error: { code: string; message: string; details?: unknown } };

// ---------- fixtures (verified test database only) ----------

async function createProduct(name: string, pricePaise: number, stockQuantity: number): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO products (name, price_paise, stock_quantity) VALUES ($1, $2, $3) RETURNING id',
    [name, pricePaise, stockQuantity],
  );
  return rows[0]?.id ?? '';
}

async function createOrder(items: { productId: string; quantity: number }[]) {
  const res = await request(app).post('/orders').send({ items });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; totalPaise: number };
}

let eventCounter = 0;
/** Pays an order through the real signed webhook (HMAC computed independently). */
async function pay(order: { id: string; totalPaise: number }, expectedOutcome = 'paid'): Promise<void> {
  eventCounter += 1;
  const raw = JSON.stringify({
    eventId: `evt_collect_${eventCounter}`,
    orderId: order.id,
    amountPaise: order.totalPaise,
    status: 'captured',
  });
  const res = await request(app)
    .post('/payments/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Pickup-Signature', `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`)
    .send(raw);
  expect(res.body).toMatchObject({ outcome: expectedOutcome });
}

async function paidOrder(items: { productId: string; quantity: number }[]) {
  const order = await createOrder(items);
  await pay(order);
  return order;
}

function collect(orderId: string, target: Parameters<typeof request>[0] = app) {
  // The frontend sends Content-Type: application/json with an empty object.
  return request(target).post(`/orders/${orderId}/collect`).send({});
}

async function stock(productId: string) {
  const { rows } = await pool.query<{ stock_quantity: number; reserved_units: number; available_units: number }>(
    'SELECT stock_quantity, reserved_units, available_units FROM product_availability WHERE product_id = $1',
    [productId],
  );
  return rows[0];
}

async function orderRow(orderId: string) {
  const { rows } = await pool.query<{ status: string; collected_at: Date | null; paid_at: Date | null }>(
    'SELECT status, collected_at, paid_at FROM orders WHERE id = $1',
    [orderId],
  );
  return rows[0];
}

async function expireReservation(orderId: string): Promise<void> {
  await pool.query(
    `UPDATE orders SET created_at = now() - interval '200 seconds', expires_at = now() - interval '1 second'
      WHERE id = $1`,
    [orderId],
  );
}

beforeEach(async () => {
  await resetDomainTables(pool);
});

// ---------- tests ----------

describe('POST /orders/:id/collect: success', () => {
  it('collects a paid order and deducts its quantity from physical stock', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const order = await paidOrder([{ productId: samosa, quantity: 3 }]);

    const res = await collect(order.id);
    const body = res.body as CollectResponse;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ id: order.id, status: 'collected', totalPaise: 6000, alreadyCollected: false });
    expect(body.expiresInSeconds).toBeNull();
    const row = await orderRow(order.id);
    expect(row?.status).toBe('collected');
    expect(row?.collected_at).not.toBeNull();
    expect(row!.collected_at!.getTime()).toBeGreaterThanOrEqual(row!.paid_at!.getTime());
    expect(await stock(samosa)).toEqual({ stock_quantity: 7, reserved_units: 0, available_units: 7 });

    const fetched = await request(app).get(`/orders/${order.id}`);
    expect(fetched.body).toMatchObject({ status: 'collected' });
  });

  it('deducts each item of a multi-product order and leaves other products untouched', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const puff = await createProduct('Paneer Puff', 3500, 6);
    const untouched = await createProduct('Masala Peanuts', 1500, 50);
    const order = await paidOrder([
      { productId: samosa, quantity: 4 },
      { productId: puff, quantity: 2 },
    ]);

    const res = await request(app).post(`/api/orders/${order.id}/collect`).send({});

    expect(res.status).toBe(200);
    expect(await stock(samosa)).toEqual({ stock_quantity: 6, reserved_units: 0, available_units: 6 });
    expect(await stock(puff)).toEqual({ stock_quantity: 4, reserved_units: 0, available_units: 4 });
    expect(await stock(untouched)).toEqual({ stock_quantity: 50, reserved_units: 0, available_units: 50 });
  });

  it('accepts an empty JSON body', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const order = await paidOrder([{ productId: samosa, quantity: 1 }]);
    const res = await collect(order.id).send({});
    expect(res.status).toBe(200);
  });
});

describe('availability across the lifecycle', () => {
  it('stays correct before and after collection, alongside other reservations', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const order = await createOrder([{ productId: samosa, quantity: 3 }]);
    expect(await stock(samosa)).toEqual({ stock_quantity: 10, reserved_units: 3, available_units: 7 });

    await pay(order);
    expect(await stock(samosa)).toEqual({ stock_quantity: 10, reserved_units: 3, available_units: 7 });

    // Another customer's active reservation on the same product.
    await createOrder([{ productId: samosa, quantity: 2 }]);
    expect(await stock(samosa)).toEqual({ stock_quantity: 10, reserved_units: 5, available_units: 5 });

    await collect(order.id);
    // Collected units leave physical stock and stop counting as reserved:
    // availability is unchanged, nothing is subtracted twice.
    expect(await stock(samosa)).toEqual({ stock_quantity: 7, reserved_units: 2, available_units: 5 });
    const catalog = await request(app).get('/products');
    expect((catalog.body as { products: { id: string; availableUnits: number }[] }).products).toEqual([
      expect.objectContaining({ id: samosa, availableUnits: 5 }),
    ]);
  });
});

describe('state machine: only paid orders can be collected', () => {
  async function expectRejected(orderId: string, productId: string, status: string) {
    const before = { order: await orderRow(orderId), stock: await stock(productId) };

    const res = await collect(orderId);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: 'ORDER_NOT_COLLECTABLE',
        message: `Only paid orders can be collected; this order is ${status}.`,
        details: { status },
      },
    });
    expect(await orderRow(orderId)).toEqual(before.order);
    expect(await stock(productId)).toEqual(before.stock);
  }

  it('rejects a pending (unpaid) order', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const order = await createOrder([{ productId: samosa, quantity: 1 }]);
    await expectRejected(order.id, samosa, 'pending');
  });

  it('rejects an unpaid order past its deadline, even before expiry is persisted', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const order = await createOrder([{ productId: samosa, quantity: 1 }]);
    await expireReservation(order.id);
    expect((await orderRow(order.id))?.status).toBe('pending');
    await expectRejected(order.id, samosa, 'expired');
  });

  it('rejects an order stored as expired', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const order = await createOrder([{ productId: samosa, quantity: 1 }]);
    await expireReservation(order.id);
    await request(app).get(`/orders/${order.id}`); // persists 'expired'
    expect((await orderRow(order.id))?.status).toBe('expired');
    await expectRejected(order.id, samosa, 'expired');
  });

  it('rejects a needs_review order (e.g. mismatched payment)', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const order = await createOrder([{ productId: samosa, quantity: 1 }]);
    await pay({ id: order.id, totalPaise: order.totalPaise + 1 }, 'amount_mismatch');
    expect((await orderRow(order.id))?.status).toBe('needs_review');
    await expectRejected(order.id, samosa, 'needs_review');
  });

  it('returns 404 for an unknown order', async () => {
    const res = await collect('a1b2c3d4-9999-4000-8000-000000000999');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'ORDER_NOT_FOUND', message: 'Order not found.' } });
  });

  it('returns 400 for a malformed id or unexpected body fields', async () => {
    const malformed = await collect('not-a-uuid');
    expect(malformed.status).toBe(400);
    expect((malformed.body as ErrorResponse).error.code).toBe('VALIDATION_ERROR');

    const samosa = await createProduct('Samosa', 2000, 10);
    const order = await paidOrder([{ productId: samosa, quantity: 1 }]);
    const extra = await collect(order.id).send({ pin: '1234' });
    expect(extra.status).toBe(400);
    expect((await orderRow(order.id))?.status).toBe('paid');
  });
});

describe('exactly-once deduction', () => {
  it('a repeated collection is acknowledged without deducting again', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const order = await paidOrder([{ productId: samosa, quantity: 3 }]);
    await collect(order.id);
    const collectedAt = (await orderRow(order.id))?.collected_at;

    const again = await collect(order.id);

    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: order.id, status: 'collected', alreadyCollected: true });
    expect((await orderRow(order.id))?.collected_at).toEqual(collectedAt);
    expect(await stock(samosa)).toEqual({ stock_quantity: 7, reserved_units: 0, available_units: 7 });
  });

  it('a payment arriving after collection changes nothing', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const order = await paidOrder([{ productId: samosa, quantity: 3 }]);
    await collect(order.id);

    await pay(order, 'order_not_payable');

    expect((await orderRow(order.id))?.status).toBe('collected');
    expect(await stock(samosa)).toEqual({ stock_quantity: 7, reserved_units: 0, available_units: 7 });
  });
});

describe('rollback on failure', () => {
  it('insufficient physical stock on one item rolls back every item and the status', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const brownie = await createProduct('Chocolate Brownie', 6000, 5);
    const order = await paidOrder([
      { productId: samosa, quantity: 4 },
      { productId: brownie, quantity: 3 },
    ]);
    // Staff write off damaged brownies after payment: only 2 left on the shelf.
    await pool.query('UPDATE products SET stock_quantity = 2 WHERE id = $1', [brownie]);

    const res = await collect(order.id);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: 'INSUFFICIENT_PHYSICAL_STOCK',
        message: 'Not enough physical stock to hand over this order.',
        details: [{ productId: brownie, required: 3, inStock: 2 }],
      },
    });
    expect((await orderRow(order.id))?.status).toBe('paid');
    expect((await stock(samosa))?.stock_quantity).toBe(10);
    expect((await stock(brownie))?.stock_quantity).toBe(2);
  });

  it('a failure after stock was deducted rolls the deduction back; a retry then succeeds', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const puff = await createProduct('Paneer Puff', 3500, 6);
    const order = await paidOrder([
      { productId: samosa, quantity: 4 },
      { productId: puff, quantity: 2 },
    ]);

    // Fail the final status update, after the product UPDATE has run (test DB only).
    await pool.query(`
      CREATE FUNCTION test_reject_collected() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated failure while marking collected'; END; $$;
      CREATE TRIGGER test_reject_collected BEFORE UPDATE ON orders
        FOR EACH ROW WHEN (NEW.status = 'collected') EXECUTE FUNCTION test_reject_collected();`);
    try {
      const res = await collect(order.id);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' },
      });
      expect((await orderRow(order.id))?.status).toBe('paid');
      expect((await stock(samosa))?.stock_quantity).toBe(10);
      expect((await stock(puff))?.stock_quantity).toBe(6);
    } finally {
      await pool.query('DROP TRIGGER test_reject_collected ON orders; DROP FUNCTION test_reject_collected();');
    }

    const retry = await collect(order.id);
    expect(retry.body).toMatchObject({ status: 'collected', alreadyCollected: false });
    expect((await stock(samosa))?.stock_quantity).toBe(6);
    expect((await stock(puff))?.stock_quantity).toBe(4);
  });

  it('a product referenced by an order cannot be deleted, so collection never meets a missing product', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const order = await paidOrder([{ productId: samosa, quantity: 1 }]);

    await expect(pool.query('DELETE FROM products WHERE id = $1', [samosa])).rejects.toMatchObject({
      code: '23503', // foreign_key_violation
    });
    expect((await collect(order.id)).status).toBe(200);
  });

  it('physical stock can never go negative', async () => {
    const samosa = await createProduct('Samosa', 2000, 1);
    await expect(
      pool.query('UPDATE products SET stock_quantity = stock_quantity - 2 WHERE id = $1', [samosa]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('POST /orders/:id/pickup-claim (the route named in the brief)', () => {
  function claim(orderId: string, target: Parameters<typeof request>[0] = app, prefix = '') {
    return request(target).post(`${prefix}/orders/${orderId}/pickup-claim`).send({});
  }

  it('claims a paid order once and deducts its stock', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const order = await paidOrder([{ productId: samosa, quantity: 3 }]);

    const res = await claim(order.id, app, '/api');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: order.id, status: 'collected', alreadyCollected: false });
    expect(await stock(samosa)).toEqual({ stock_quantity: 7, reserved_units: 0, available_units: 7 });
  });

  it('rejects a repeated claim with 409 and does not deduct again', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const order = await paidOrder([{ productId: samosa, quantity: 3 }]);
    await claim(order.id);
    const collectedAt = (await orderRow(order.id))?.collected_at;

    const again = await claim(order.id);

    expect(again.status).toBe(409);
    expect(again.body).toEqual({
      error: {
        code: 'ORDER_ALREADY_COLLECTED',
        message: 'This order has already been collected.',
        details: { status: 'collected' },
      },
    });
    expect((await orderRow(order.id))?.collected_at).toEqual(collectedAt);
    expect(await stock(samosa)).toEqual({ stock_quantity: 7, reserved_units: 0, available_units: 7 });
  });

  it('rejects unpaid orders, unknown orders and non-JSON requests', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const pending = await createOrder([{ productId: samosa, quantity: 1 }]);

    const unpaid = await claim(pending.id);
    expect(unpaid.status).toBe(409);
    expect((unpaid.body as ErrorResponse).error.code).toBe('ORDER_NOT_COLLECTABLE');

    const unknown = await claim('a1b2c3d4-9999-4000-8000-000000000999');
    expect(unknown.status).toBe(404);

    const paid = await paidOrder([{ productId: samosa, quantity: 1 }]);
    const bare = await request(app).post(`/orders/${paid.id}/pickup-claim`);
    expect(bare.status).toBe(415);
    expect((await orderRow(paid.id))?.status).toBe('paid');
    expect((await stock(samosa))?.stock_quantity).toBe(10);
  });
});

describe('concurrency (real overlapping transactions)', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  async function holdLock(sql: string, params: unknown[]): Promise<() => Promise<void>> {
    const gate = new pg.Client({ connectionString: testDatabaseUrl });
    await gate.connect();
    await gate.query('BEGIN');
    await gate.query(sql, params);
    return async () => {
      await gate.query('COMMIT');
      await gate.end();
    };
  }

  async function waitForBlocked(tag: string, count: number): Promise<void> {
    const deadline = Date.now() + 4_000;
    for (;;) {
      const { rows } = await pool.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
        [`%${tag}%`],
      );
      if ((rows[0]?.waiting ?? 0) === count) return;
      if (Date.now() > deadline) throw new Error(`Expected ${count} sessions blocked on ${tag}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  // Required by the brief: two pickup claims arrive simultaneously.
  it('two simultaneous pickup claims: exactly one succeeds, the other gets 409', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const order = await paidOrder([{ productId: samosa, quantity: 3 }]);
    const release = await holdLock('SELECT 1 FROM orders WHERE id = $1 FOR UPDATE', [order.id]);

    const pending = [1, 2].map(() =>
      request(baseUrl).post(`/orders/${order.id}/pickup-claim`).send({}).then((res) => res),
    );
    await waitForBlocked('collect:lock-order', 2); // both claims are inside PostgreSQL at once
    await release();
    const results = await Promise.all(pending);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 200)?.body).toMatchObject({ status: 'collected' });
    expect((results.find((r) => r.status === 409)?.body as ErrorResponse).error.code).toBe(
      'ORDER_ALREADY_COLLECTED',
    );
    expect((await orderRow(order.id))?.status).toBe('collected');
    expect(await stock(samosa)).toEqual({ stock_quantity: 7, reserved_units: 0, available_units: 7 });
  });

  it('two simultaneous collections of one order deduct stock exactly once', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const order = await paidOrder([{ productId: samosa, quantity: 3 }]);
    const release = await holdLock('SELECT 1 FROM orders WHERE id = $1 FOR UPDATE', [order.id]);

    const pending = [1, 2].map(() => collect(order.id, baseUrl).then((res) => res));
    await waitForBlocked('collect:lock-order', 2); // both are inside PostgreSQL at once
    await release();
    const results = await Promise.all(pending);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map((r) => (r.body as CollectResponse).alreadyCollected).sort()).toEqual([false, true]);
    expect(await stock(samosa)).toEqual({ stock_quantity: 7, reserved_units: 0, available_units: 7 });
  });

  it('two different orders collecting the same product concurrently lose no update', async () => {
    const samosa = await createProduct('Samosa', 2000, 10);
    const first = await paidOrder([{ productId: samosa, quantity: 3 }]);
    const second = await paidOrder([{ productId: samosa, quantity: 4 }]);
    const release = await holdLock('SELECT 1 FROM products WHERE id = $1 FOR UPDATE', [samosa]);

    const pending = [first, second].map((o) => collect(o.id, baseUrl).then((res) => res));
    await waitForBlocked('collect:lock-products', 2);
    await release();
    const results = await Promise.all(pending);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as CollectResponse).alreadyCollected === false)).toBe(true);
    expect(await stock(samosa)).toEqual({ stock_quantity: 3, reserved_units: 0, available_units: 3 });
  });

  it('multi-product orders collecting in parallel do not deadlock', async () => {
    const a = await createProduct('Product A', 1000, 20);
    const b = await createProduct('Product B', 1000, 20);
    // Request items in opposite orders; locks are still taken in id order.
    const orders = await Promise.all([
      paidOrder([{ productId: a, quantity: 1 }, { productId: b, quantity: 1 }]),
      paidOrder([{ productId: b, quantity: 2 }, { productId: a, quantity: 2 }]),
      paidOrder([{ productId: a, quantity: 3 }, { productId: b, quantity: 3 }]),
    ]);

    const results = await Promise.all(orders.map((o) => collect(o.id, baseUrl).then((res) => res)));

    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect((await stock(a))?.stock_quantity).toBe(14);
    expect((await stock(b))?.stock_quantity).toBe(14);
  });
});

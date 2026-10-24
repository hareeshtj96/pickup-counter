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

type WebhookResult = {
  eventId: string;
  orderId: string;
  outcome: string;
  orderStatus: string;
  duplicate: boolean;
};
type ErrorResponse = { error: { code: string; message: string; details?: unknown } };
type Payload = { eventId: string; orderId: string; amountPaise: number; status: string };

// ---------- signing (computed here independently of the app's helper) ----------

function sign(rawBody: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

let eventCounter = 0;
function payload(orderId: string, amountPaise: number, overrides: Partial<Payload> = {}): Payload {
  eventCounter += 1;
  return { eventId: `evt_test_${eventCounter}`, orderId, amountPaise, status: 'captured', ...overrides };
}

/** Sends `body` byte-for-byte; signs it unless a signature (or null for none) is given. */
function sendRaw(rawBody: string, signature: string | null = sign(rawBody), target: Parameters<typeof request>[0] = app) {
  const req = request(target).post('/payments/webhook').set('Content-Type', 'application/json');
  if (signature !== null) req.set('X-Pickup-Signature', signature);
  return req.send(rawBody);
}

function sendEvent(event: Payload, target: Parameters<typeof request>[0] = app) {
  return sendRaw(JSON.stringify(event), undefined, target);
}

// ---------- fixtures (verified test database only) ----------

async function createProduct(name: string, pricePaise: number, stockQuantity: number): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO products (name, price_paise, stock_quantity) VALUES ($1, $2, $3) RETURNING id',
    [name, pricePaise, stockQuantity],
  );
  return rows[0]?.id ?? '';
}

async function createOrder(productId: string, quantity: number): Promise<{ id: string; totalPaise: number }> {
  const res = await request(app).post('/orders').send({ items: [{ productId, quantity }] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; totalPaise: number };
}

/** A pending order for 2 x Rs 20 (total 4000 paise) of a product with `stock` units. */
async function pendingOrder(stock = 10) {
  const productId = await createProduct('Samosa', 2000, stock);
  const order = await createOrder(productId, 2);
  return { productId, orderId: order.id, total: order.totalPaise };
}

async function expireReservation(orderId: string): Promise<void> {
  await pool.query(
    `UPDATE orders SET created_at = now() - interval '200 seconds', expires_at = now() - interval '1 second'
      WHERE id = $1`,
    [orderId],
  );
}

type OrderRow = {
  status: string;
  paid_at: Date | null;
  expired_at: Date | null;
  expires_at: Date;
  updated_at: Date;
};
async function orderRow(orderId: string): Promise<OrderRow> {
  const { rows } = await pool.query<OrderRow>(
    'SELECT status, paid_at, expired_at, expires_at, updated_at FROM orders WHERE id = $1',
    [orderId],
  );
  const row = rows[0];
  if (!row) throw new Error('order not found');
  return row;
}

async function events(orderId?: string) {
  const { rows } = await pool.query<{ event_id: string; outcome: string; detail: string | null; raw_payload: string; amount_paise: number }>(
    `SELECT event_id, outcome, detail, raw_payload, amount_paise FROM payment_events
      WHERE $1::uuid IS NULL OR order_id = $1 ORDER BY received_at, event_id`,
    [orderId ?? null],
  );
  return rows;
}

async function stock(productId: string) {
  const { rows } = await pool.query<{ stock_quantity: number; reserved_units: number; available_units: number }>(
    'SELECT stock_quantity, reserved_units, available_units FROM product_availability WHERE product_id = $1',
    [productId],
  );
  return rows[0];
}

beforeEach(async () => {
  await resetDomainTables(pool);
});

// ---------- tests ----------

describe('signature verification', () => {
  it('accepts a valid signature and pays a pending order before expiry', async () => {
    const { productId, orderId, total } = await pendingOrder();
    const event = payload(orderId, total);
    const raw = JSON.stringify(event);

    const res = await sendRaw(raw);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ eventId: event.eventId, orderId, outcome: 'paid', orderStatus: 'paid', duplicate: false });

    const order = await orderRow(orderId);
    expect(order.status).toBe('paid');
    expect(order.paid_at).not.toBeNull();
    expect(order.paid_at!.getTime()).toBeLessThan(order.expires_at.getTime());

    expect(await events(orderId)).toEqual([
      { event_id: event.eventId, outcome: 'paid', detail: null, raw_payload: raw, amount_paise: total },
    ]);
    // Paid orders keep their reservation; physical stock is untouched until pickup.
    expect(await stock(productId)).toEqual({ stock_quantity: 10, reserved_units: 2, available_units: 8 });

    const status = await request(app).get(`/orders/${orderId}`);
    expect(status.body).toMatchObject({ status: 'paid', expiresInSeconds: null });
  });

  it('is also served under /api', async () => {
    const { orderId, total } = await pendingOrder();
    const raw = JSON.stringify(payload(orderId, total));
    const res = await request(app)
      .post('/api/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Pickup-Signature', sign(raw))
      .send(raw);
    expect(res.status).toBe(200);
  });

  it('verifies the exact raw bytes, not re-serialised JSON', async () => {
    const { orderId, total } = await pendingOrder();
    const event = payload(orderId, total);
    // Unusual spacing and key order: re-serialising would produce different bytes.
    const raw = `{ "status":"captured",  "amountPaise": ${total}, "orderId":"${orderId}", "eventId":"${event.eventId}" }`;

    const reserialised = JSON.stringify(JSON.parse(raw) as unknown);
    const wrong = await sendRaw(raw, sign(reserialised));
    expect(wrong.status).toBe(401);
    expect((wrong.body as ErrorResponse).error.code).toBe('SIGNATURE_INVALID');

    const right = await sendRaw(raw, sign(raw));
    expect(right.status).toBe(200);
    expect(await events(orderId)).toHaveLength(1);
    expect((await events(orderId))[0]?.raw_payload).toBe(raw);
  });

  describe('rejects bad signatures before touching any payment data', () => {
    let orderId: string;
    let raw: string;

    beforeEach(async () => {
      const order = await pendingOrder();
      orderId = order.orderId;
      raw = JSON.stringify(payload(orderId, order.total));
    });

    async function expectUntouched(): Promise<void> {
      expect(await events()).toEqual([]);
      expect((await orderRow(orderId)).status).toBe('pending');
    }

    it('missing signature -> 401 SIGNATURE_MISSING', async () => {
      const res = await sendRaw(raw, null);
      expect(res.status).toBe(401);
      expect((res.body as ErrorResponse).error.code).toBe('SIGNATURE_MISSING');
      await expectUntouched();
    });

    it('signature from the wrong secret -> 401 SIGNATURE_INVALID', async () => {
      const res = await sendRaw(raw, sign(raw, 'some-other-secret-that-is-long-enough!!'));
      expect(res.status).toBe(401);
      expect((res.body as ErrorResponse).error.code).toBe('SIGNATURE_INVALID');
      await expectUntouched();
    });

    it('valid signature for a different body (tampering) -> 401 SIGNATURE_INVALID', async () => {
      const tampered = raw.replace(/"amountPaise":\d+/, '"amountPaise":1');
      const res = await sendRaw(tampered, sign(raw));
      expect(res.status).toBe(401);
      expect((res.body as ErrorResponse).error.code).toBe('SIGNATURE_INVALID');
      await expectUntouched();
    });

    it.each([
      ['no scheme', () => createHmac('sha256', SECRET).update(raw).digest('hex')],
      ['wrong scheme', () => sign(raw).replace('sha256=', 'sha1=')],
      ['non-hex characters', () => `sha256=${'z'.repeat(64)}`],
      ['too short', () => sign(raw).slice(0, -2)],
      ['too long', () => `${sign(raw)}00`],
      ['uppercase hex', () => sign(raw).toUpperCase().replace('SHA256=', 'sha256=')],
      ['base64 digest', () => `sha256=${createHmac('sha256', SECRET).update(raw).digest('base64')}`],
      ['empty value', () => 'sha256='],
    ])('malformed signature (%s) -> 401 SIGNATURE_MALFORMED', async (_label, makeSignature) => {
      const res = await sendRaw(raw, makeSignature());
      expect(res.status).toBe(401);
      expect((res.body as ErrorResponse).error.code).toBe('SIGNATURE_MALFORMED');
      await expectUntouched();
    });

    it('never echoes the secret', async () => {
      const res = await sendRaw(raw, sign(raw, 'wrong-secret-wrong-secret-wrong-secret'));
      expect(res.text).not.toContain(SECRET);
    });
  });
});

describe('payload validation (correctly signed)', () => {
  const orderId = 'a1b2c3d4-0001-4000-8000-000000000001';

  it('rejects invalid JSON with 400 INVALID_JSON', async () => {
    const res = await sendRaw('{"eventId":"evt_1",');
    expect(res.status).toBe(400);
    expect((res.body as ErrorResponse).error.code).toBe('INVALID_JSON');
  });

  it.each([
    ['empty object', {}],
    ['missing eventId', { orderId, amountPaise: 4000, status: 'captured' }],
    ['blank eventId', { eventId: '', orderId, amountPaise: 4000, status: 'captured' }],
    ['eventId with spaces', { eventId: 'evt 1', orderId, amountPaise: 4000, status: 'captured' }],
    ['orderId not a UUID', { eventId: 'evt_1', orderId: '42', amountPaise: 4000, status: 'captured' }],
    ['fractional amount', { eventId: 'evt_1', orderId, amountPaise: 40.5, status: 'captured' }],
    ['amount as a string', { eventId: 'evt_1', orderId, amountPaise: '4000', status: 'captured' }],
    ['zero amount', { eventId: 'evt_1', orderId, amountPaise: 0, status: 'captured' }],
    ['negative amount', { eventId: 'evt_1', orderId, amountPaise: -4000, status: 'captured' }],
    ['unknown field', { eventId: 'evt_1', orderId, amountPaise: 4000, status: 'captured', orderStatus: 'paid' }],
    ['array body', [1, 2, 3]],
  ])('rejects %s with 400 VALIDATION_ERROR', async (_label, body) => {
    const res = await sendRaw(JSON.stringify(body));
    expect(res.status).toBe(400);
    expect((res.body as ErrorResponse).error.code).toBe('VALIDATION_ERROR');
    expect(await events()).toEqual([]);
  });

  it('rejects an unsupported status with 400', async () => {
    const res = await sendRaw(JSON.stringify({ eventId: 'evt_1', orderId, amountPaise: 4000, status: 'refunded' }));
    expect(res.status).toBe(400);
    expect((res.body as ErrorResponse).error.details).toEqual([
      { path: 'body.status', message: 'status must be one of: captured, failed' },
    ]);
  });

  it('returns 404 for an unknown order and records nothing', async () => {
    const res = await sendEvent(payload('a1b2c3d4-9999-4000-8000-000000000999', 4000));
    expect(res.status).toBe(404);
    expect((res.body as ErrorResponse).error.code).toBe('ORDER_NOT_FOUND');
    expect(await events()).toEqual([]);
  });
});

describe('payment decisions', () => {
  it('amount mismatch: needs_review, not paid, no extra stock reserved', async () => {
    const { productId, orderId, total } = await pendingOrder();

    const res = await sendEvent(payload(orderId, total - 1));

    expect(res.body).toMatchObject({ outcome: 'amount_mismatch', orderStatus: 'needs_review', duplicate: false });
    const order = await orderRow(orderId);
    expect(order).toMatchObject({ status: 'needs_review', paid_at: null });
    expect((await events(orderId))[0]?.detail).toBe('Paid 3999 paise; order total is 4000 paise.');
    // needs_review holds no stock and physical stock is unchanged.
    expect(await stock(productId)).toEqual({ stock_quantity: 10, reserved_units: 0, available_units: 10 });
  });

  it('late payment (deadline passed, status not yet persisted): needs_review, never paid', async () => {
    const { orderId, total } = await pendingOrder();
    await expireReservation(orderId);
    expect((await orderRow(orderId)).status).toBe('pending');

    const res = await sendEvent(payload(orderId, total));

    expect(res.body).toMatchObject({ outcome: 'late_payment', orderStatus: 'needs_review' });
    const order = await orderRow(orderId);
    expect(order.status).toBe('needs_review');
    expect(order.paid_at).toBeNull();
    expect(order.expired_at).not.toBeNull();
    expect((await events(orderId))[0]?.detail).toBe(
      'Payment captured after the reservation expired; stock was not re-reserved.',
    );
  });

  it('late payment for an order already marked expired: needs_review', async () => {
    const { orderId, total } = await pendingOrder();
    await expireReservation(orderId);
    await request(app).get(`/orders/${orderId}`); // persists 'expired'
    expect((await orderRow(orderId)).status).toBe('expired');

    const res = await sendEvent(payload(orderId, total + 500));

    expect(res.body).toMatchObject({ outcome: 'late_payment', orderStatus: 'needs_review' });
    expect((await events(orderId))[0]?.detail).toBe(
      'Payment captured after the reservation expired; stock was not re-reserved. Paid 4500 paise; order total is 4000 paise.',
    );
  });

  it('a late payment never takes back stock already sold to someone else', async () => {
    const productId = await createProduct('Last Brownies', 6000, 5);
    const first = await createOrder(productId, 5);
    await expireReservation(first.id);
    const second = await createOrder(productId, 5); // takes the released units

    const res = await sendEvent(payload(first.id, first.totalPaise));

    expect(res.body).toMatchObject({ outcome: 'late_payment', orderStatus: 'needs_review' });
    expect((await orderRow(second.id)).status).toBe('pending');
    expect(await stock(productId)).toEqual({ stock_quantity: 5, reserved_units: 5, available_units: 0 });
  });

  it('a failed payment event is recorded and changes nothing', async () => {
    const { productId, orderId, total } = await pendingOrder();

    const res = await sendEvent(payload(orderId, total, { status: 'failed' }));

    expect(res.body).toMatchObject({ outcome: 'payment_failed', orderStatus: 'pending' });
    expect((await orderRow(orderId)).status).toBe('pending');
    expect(await stock(productId)).toMatchObject({ reserved_units: 2 });
  });

  it.each(['needs_review', 'collected'])('an order in %s is not paid or revived', async (state) => {
    const { orderId, total } = await pendingOrder();
    await pool.query(
      `UPDATE orders SET status = $2, paid_at = CASE WHEN $2 = 'collected' THEN now() END,
              collected_at = CASE WHEN $2 = 'collected' THEN now() END
        WHERE id = $1`,
      [orderId, state],
    );
    const before = await orderRow(orderId);

    const res = await sendEvent(payload(orderId, total));

    expect(res.body).toMatchObject({ outcome: 'order_not_payable', orderStatus: state, duplicate: false });
    expect(await orderRow(orderId)).toEqual(before);
    expect((await events(orderId))[0]?.detail).toBe(`Order is ${state}; no change applied.`);
  });
});

describe('idempotency', () => {
  it('a duplicate event delivered later is acknowledged without re-applying', async () => {
    const { orderId, total } = await pendingOrder();
    const event = payload(orderId, total);

    const first = await sendEvent(event);
    const paidAt = (await orderRow(orderId)).paid_at;
    const second = await sendEvent(event);

    expect(first.body).toMatchObject({ outcome: 'paid', duplicate: false });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ eventId: event.eventId, orderId, outcome: 'paid', orderStatus: 'paid', duplicate: true });
    expect(await events(orderId)).toHaveLength(1);
    expect((await orderRow(orderId)).paid_at).toEqual(paidAt);
  });

  it('a late duplicate of a paid event stays paid (it is not re-evaluated)', async () => {
    const { orderId, total } = await pendingOrder();
    const event = payload(orderId, total);
    await sendEvent(event);
    await expireReservation(orderId);

    const again = await sendEvent(event);

    expect(again.body).toMatchObject({ outcome: 'paid', orderStatus: 'paid', duplicate: true });
  });

  it('rejects an eventId reused for a different payment with 409', async () => {
    const { orderId, total } = await pendingOrder();
    const event = payload(orderId, total);
    await sendEvent(event);

    const res = await sendEvent({ ...event, amountPaise: total + 1 });

    expect(res.status).toBe(409);
    expect((res.body as ErrorResponse).error.code).toBe('EVENT_ID_CONFLICT');
    expect(await events(orderId)).toHaveLength(1);
  });

  it('a second, distinct event for an already-paid order does not pay it again', async () => {
    const { orderId, total } = await pendingOrder();
    await sendEvent(payload(orderId, total));
    const paidAt = (await orderRow(orderId)).paid_at;

    const res = await sendEvent(payload(orderId, total));

    expect(res.body).toMatchObject({ outcome: 'already_paid', orderStatus: 'paid', duplicate: false });
    expect((await orderRow(orderId)).paid_at).toEqual(paidAt);
    expect((await events(orderId)).map((e) => e.outcome)).toEqual(['paid', 'already_paid']);
  });
});

describe('failure handling', () => {
  it('rolls back the event when applying it fails, so a retry can succeed', async () => {
    const { orderId, total } = await pendingOrder();
    const event = payload(orderId, total);

    // Make the order update fail inside the transaction (test database only).
    await pool.query(`
      CREATE FUNCTION test_reject_paid() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated failure while marking paid'; END; $$;
      CREATE TRIGGER test_reject_paid BEFORE UPDATE ON orders
        FOR EACH ROW WHEN (NEW.status = 'paid') EXECUTE FUNCTION test_reject_paid();`);
    try {
      const res = await sendEvent(event);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' },
      });
      expect(res.text).not.toContain('simulated failure');
      // Neither the event nor the status change survived.
      expect(await events()).toEqual([]);
      expect((await orderRow(orderId)).status).toBe('pending');
    } finally {
      await pool.query('DROP TRIGGER test_reject_paid ON orders; DROP FUNCTION test_reject_paid();');
    }

    const retry = await sendEvent(event);
    expect(retry.body).toMatchObject({ outcome: 'paid', duplicate: false });
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

  /** Holds a row lock on a separate connection until released. */
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

  /** Waits until `count` sessions are blocked on a lock while running SQL tagged with `tag`. */
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

  it('five simultaneous copies of one event apply it exactly once', async () => {
    const { orderId, total } = await pendingOrder();
    const event = payload(orderId, total);
    const release = await holdLock('SELECT 1 FROM orders WHERE id = $1 FOR UPDATE', [orderId]);

    const pending = Array.from({ length: 5 }, () => sendEvent(event, baseUrl).then((res) => res));
    await waitForBlocked('payment:lock-order', 5); // all five are inside PostgreSQL at once
    await release();
    const results = await Promise.all(pending);

    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const bodies = results.map((r) => r.body as WebhookResult);
    expect(bodies.filter((b) => !b.duplicate)).toHaveLength(1);
    expect(bodies.every((b) => b.outcome === 'paid' && b.orderStatus === 'paid')).toBe(true);
    expect(await events(orderId)).toHaveLength(1);
    expect((await orderRow(orderId)).status).toBe('paid');
  });

  it('two simultaneous distinct events for one order: one pays, one is already_paid', async () => {
    const { orderId, total } = await pendingOrder();
    const release = await holdLock('SELECT 1 FROM orders WHERE id = $1 FOR UPDATE', [orderId]);

    const pending = [payload(orderId, total), payload(orderId, total)].map((e) =>
      sendEvent(e, baseUrl).then((res) => res),
    );
    await waitForBlocked('payment:lock-order', 2);
    await release();
    const results = await Promise.all(pending);

    const outcomes = results.map((r) => (r.body as WebhookResult).outcome).sort();
    expect(outcomes).toEqual(['already_paid', 'paid']);
    expect(await events(orderId)).toHaveLength(2);
  });

  it('the same eventId racing for two different orders is applied once (UNIQUE constraint)', async () => {
    const productId = await createProduct('Samosa', 2000, 10);
    const a = await createOrder(productId, 2);
    const b = await createOrder(productId, 2);
    // Both requests pass their own order lock and the duplicate lookup, then
    // queue on the shared product row; the loser then hits UNIQUE(event_id).
    const release = await holdLock('SELECT 1 FROM products WHERE id = $1 FOR UPDATE', [productId]);

    const pending = [a, b].map((o) =>
      sendEvent({ eventId: 'evt_shared', orderId: o.id, amountPaise: 4000, status: 'captured' }, baseUrl).then(
        (res) => res,
      ),
    );
    await waitForBlocked('payment:lock-products', 2);
    await release();
    const results = await Promise.all(pending);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((results.find((r) => r.status === 409)?.body as ErrorResponse).error.code).toBe('EVENT_ID_CONFLICT');
    const { rows } = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM payment_events WHERE event_id = 'evt_shared'",
    );
    expect(rows[0]?.count).toBe(1);
    const statuses = [(await orderRow(a.id)).status, (await orderRow(b.id)).status].sort();
    expect(statuses).toEqual(['paid', 'pending']);
  });

  it('waits for in-flight order creation on the same products before deciding', async () => {
    const { productId, orderId, total } = await pendingOrder();
    const release = await holdLock('SELECT 1 FROM products WHERE id = $1 FOR UPDATE', [productId]);

    const pending = sendEvent(payload(orderId, total), baseUrl).then((res) => res);
    await waitForBlocked('payment:lock-products', 1); // the payment cannot decide yet
    expect((await orderRow(orderId)).status).toBe('pending');
    await release();

    expect((await pending).body).toMatchObject({ outcome: 'paid' });
  });
});

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { pool } from '../src/db/pool.js';
import { resetDomainTables } from './helpers/testDatabase.js';

const enabledApp = createApp({ devPaymentSimulator: true });
const disabledApp = createApp({ devPaymentSimulator: false });

type ErrorResponse = { error: { code: string } };

async function pendingOrder(): Promise<{ id: string; totalPaise: number }> {
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO products (name, price_paise, stock_quantity) VALUES ('Samosa', 2000, 10) RETURNING id",
  );
  const res = await request(enabledApp)
    .post('/orders')
    .send({ items: [{ productId: rows[0]?.id, quantity: 2 }] });
  expect(res.status).toBe(201);
  return res.body as { id: string; totalPaise: number };
}

async function orderStatus(id: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [id]);
  return rows[0]?.status;
}

beforeEach(async () => {
  await resetDomainTables(pool);
});

describe('POST /dev/orders/:id/simulate-payment (development only)', () => {
  it('pays a pending order through the normal payment service, using the stored total', async () => {
    const order = await pendingOrder();

    const res = await request(enabledApp).post(`/api/dev/orders/${order.id}/simulate-payment`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ orderId: order.id, outcome: 'paid', orderStatus: 'paid', duplicate: false });
    expect(await orderStatus(order.id)).toBe('paid');

    const { rows } = await pool.query<{ event_id: string; amount_paise: number; raw_payload: string }>(
      'SELECT event_id, amount_paise, raw_payload FROM payment_events WHERE order_id = $1',
      [order.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_id).toMatch(/^devsim_[0-9a-f-]{36}$/);
    expect(rows[0]?.amount_paise).toBe(order.totalPaise);
    expect(JSON.parse(rows[0]?.raw_payload ?? '{}')).toMatchObject({ source: 'dev-payment-simulator' });
  });

  it('cannot revive an expired reservation: a late simulated payment becomes needs_review', async () => {
    const order = await pendingOrder();
    await pool.query(
      `UPDATE orders SET created_at = now() - interval '200 seconds', expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [order.id],
    );

    const res = await request(enabledApp).post(`/dev/orders/${order.id}/simulate-payment`);

    expect(res.body).toMatchObject({ outcome: 'late_payment', orderStatus: 'needs_review' });
    expect(await orderStatus(order.id)).toBe('needs_review');
  });

  it('does not pay an already-paid order twice', async () => {
    const order = await pendingOrder();
    await request(enabledApp).post(`/dev/orders/${order.id}/simulate-payment`);

    const again = await request(enabledApp).post(`/dev/orders/${order.id}/simulate-payment`);

    expect(again.body).toMatchObject({ outcome: 'already_paid', orderStatus: 'paid' });
  });

  it('accepts no client-supplied amount or status, and validates the id', async () => {
    const order = await pendingOrder();

    const withBody = await request(enabledApp)
      .post(`/dev/orders/${order.id}/simulate-payment`)
      .send({ amountPaise: 1, status: 'captured' });
    expect(withBody.status).toBe(400);
    expect(await orderStatus(order.id)).toBe('pending');

    const malformed = await request(enabledApp).post('/dev/orders/not-a-uuid/simulate-payment');
    expect(malformed.status).toBe(400);

    const unknown = await request(enabledApp).post('/dev/orders/a1b2c3d4-9999-4000-8000-000000000999/simulate-payment');
    expect(unknown.status).toBe(404);
    expect((unknown.body as ErrorResponse).error.code).toBe('ORDER_NOT_FOUND');
  });

  it('does not exist when the simulator is disabled', async () => {
    const order = await pendingOrder();

    for (const path of [`/dev/orders/${order.id}/simulate-payment`, `/api/dev/orders/${order.id}/simulate-payment`]) {
      const res = await request(disabledApp).post(path);
      expect(res.status).toBe(404);
      expect((res.body as ErrorResponse).error.code).toBe('NOT_FOUND');
    }
    expect(await orderStatus(order.id)).toBe('pending');
  });
});

describe('DEV_PAYMENT_SIMULATOR configuration', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@db:5432/pickup_counter',
    PAYMENT_WEBHOOK_SECRET: 'a-real-looking-secret-that-is-long-enough-123',
  };

  it('is off unless explicitly enabled', () => {
    expect(parseEnv({ ...base }).DEV_PAYMENT_SIMULATOR).toBe(false);
    expect(parseEnv({ ...base, DEV_PAYMENT_SIMULATOR: 'true' }).DEV_PAYMENT_SIMULATOR).toBe(true);
    expect(() => parseEnv({ ...base, DEV_PAYMENT_SIMULATOR: 'yes' })).toThrow(/DEV_PAYMENT_SIMULATOR/);
  });

  it('cannot be enabled in production', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'production', DEV_PAYMENT_SIMULATOR: 'true' })).toThrow(
      /DEV_PAYMENT_SIMULATOR: the development payment simulator cannot be enabled in production/,
    );
    expect(parseEnv({ ...base, NODE_ENV: 'production', DEV_PAYMENT_SIMULATOR: 'false' }).DEV_PAYMENT_SIMULATOR).toBe(
      false,
    );
  });
});

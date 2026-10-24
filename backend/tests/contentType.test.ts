import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { resetDomainTables } from './helpers/testDatabase.js';

// State-changing POSTs without a meaningful body must still declare JSON, so a
// third-party page cannot fire them as CORS "simple requests" (see
// src/middleware/requireJson.ts).
const app = createApp({ devPaymentSimulator: true });

const UNSUPPORTED = {
  error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json.' },
};

async function snapshot(orderId: string) {
  const { rows } = await pool.query<{ status: string; stock: number; events: number }>(
    `SELECT o.status,
            (SELECT p.stock_quantity FROM products p JOIN order_items oi ON oi.product_id = p.id
              WHERE oi.order_id = o.id) AS stock,
            (SELECT count(*)::int FROM payment_events) AS events
       FROM orders o WHERE o.id = $1`,
    [orderId],
  );
  return rows[0];
}

/** A pending order (2 x Samosa); `paid` pays it through the simulator first. */
async function order(paid: boolean): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO products (name, price_paise, stock_quantity) VALUES ('Samosa', 2000, 10) RETURNING id",
  );
  const created = await request(app).post('/orders').send({ items: [{ productId: rows[0]?.id, quantity: 2 }] });
  const id = (created.body as { id: string }).id;
  if (paid) {
    const res = await request(app).post(`/dev/orders/${id}/simulate-payment`).send({});
    expect(res.body).toMatchObject({ outcome: 'paid' });
  }
  return id;
}

beforeEach(async () => {
  await resetDomainTables(pool);
});

describe.each([
  { route: 'POST /orders/:id/collect', path: (id: string) => `/orders/${id}/collect`, paid: true },
  { route: 'POST /dev/orders/:id/simulate-payment', path: (id: string) => `/dev/orders/${id}/simulate-payment`, paid: false },
])('$route content type', ({ path, paid }) => {
  it.each([
    ['no Content-Type and no body', (url: string) => request(app).post(url)],
    ['text/plain', (url: string) => request(app).post(url).set('Content-Type', 'text/plain').send('{}')],
    [
      'application/x-www-form-urlencoded',
      (url: string) => request(app).post(url).set('Content-Type', 'application/x-www-form-urlencoded').send('a=1'),
    ],
    ['multipart/form-data', (url: string) => request(app).post(url).field('a', '1')],
    ['a look-alike type', (url: string) => request(app).post(url).set('Content-Type', 'application/jsonp').send('{}')],
  ])('rejects %s with 415 and changes nothing', async (_label, send) => {
    const id = await order(paid);
    const before = await snapshot(id);

    const res = await send(path(id));

    expect(res.status).toBe(415);
    expect(res.body).toEqual(UNSUPPORTED);
    expect(await snapshot(id)).toEqual(before);
  });

  it.each([
    ['an empty JSON object', (url: string) => request(app).post(url).send({})],
    [
      'JSON with a charset parameter',
      (url: string) => request(app).post(url).set('Content-Type', 'application/json; charset=utf-8').send('{}'),
    ],
    ['JSON Content-Type with no body', (url: string) => request(app).post(url).set('Content-Type', 'application/json')],
    ['upper-case media type', (url: string) => request(app).post(url).set('Content-Type', 'Application/JSON').send('{}')],
  ])('accepts %s', async (_label, send) => {
    const id = await order(paid);

    const res = await send(path(id));

    expect(res.status).toBe(200);
    expect((await snapshot(id))?.status).toBe(paid ? 'collected' : 'paid');
  });

  it('still validates the body after the content type', async () => {
    const id = await order(paid);
    const res = await request(app).post(path(id)).send({ amountPaise: 1 });
    expect(res.status).toBe(400);
  });
});

describe('cross-origin requests', () => {
  it('a CORS preflight from another origin is not granted', async () => {
    const res = await request(app)
      .options('/orders/a1b2c3d4-9999-4000-8000-000000000999/collect')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

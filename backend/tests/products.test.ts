import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { SEED_PRODUCTS, assertSeedTargetAllowed, runSeed } from '../src/db/seed.js';
import { resetDomainTables } from './helpers/testDatabase.js';

const app = createApp();

type ProductsResponse = {
  products: { id: string; name: string; pricePaise: number; availableUnits: number }[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function countProducts(): Promise<number> {
  const { rows } = await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM products');
  return rows[0]?.count ?? -1;
}

beforeEach(async () => {
  await resetDomainTables(pool);
});

describe('seed script (real PostgreSQL)', () => {
  it('inserts the catalog once and is safe to run again', async () => {
    expect(await runSeed(pool, 'test')).toBe(SEED_PRODUCTS.length);
    expect(await runSeed(pool, 'test')).toBe(0);
    expect(await countProducts()).toBe(SEED_PRODUCTS.length);
  });

  it('does not overwrite stock that changed after seeding', async () => {
    await runSeed(pool, 'test');
    const first = SEED_PRODUCTS[0];
    await pool.query('UPDATE products SET stock_quantity = 3 WHERE id = $1', [first?.id]);

    await runSeed(pool, 'test');

    const { rows } = await pool.query<{ stock_quantity: number }>(
      'SELECT stock_quantity FROM products WHERE id = $1',
      [first?.id],
    );
    expect(rows[0]?.stock_quantity).toBe(3);
  });

  it('only allows development and test databases', () => {
    expect(() => assertSeedTargetAllowed('pickup_counter', 'development')).not.toThrow();
    expect(() => assertSeedTargetAllowed('pickup_counter_test', 'test')).not.toThrow();
    expect(() => assertSeedTargetAllowed('shop_dev', 'development')).not.toThrow();
    expect(() => assertSeedTargetAllowed('pickup_counter', 'production')).toThrow(/production/);
    expect(() => assertSeedTargetAllowed('pickup_counter_prod', 'development')).toThrow(/Refusing/);
    expect(() => assertSeedTargetAllowed('postgres', 'development')).toThrow(/Refusing/);
  });
});

describe('GET /products (real PostgreSQL)', () => {
  it('returns an empty list when there are no products', async () => {
    const res = await request(app).get('/products');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ products: [] });
  });

  it.each(['/products', '/api/products'])('GET %s returns the seeded products', async (path) => {
    await runSeed(pool, 'test');

    const res = await request(app).get(path);
    const { products } = res.body as ProductsResponse;

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(products).toHaveLength(SEED_PRODUCTS.length);

    // Sorted by name, with exactly the public fields.
    const expected = [...SEED_PRODUCTS]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ id: p.id, name: p.name, pricePaise: p.pricePaise, availableUnits: p.stockQuantity }));
    expect(products).toEqual(expected);
  });

  it('returns integer paise and non-negative integer stock', async () => {
    await runSeed(pool, 'test');

    const res = await request(app).get('/products');
    const { products } = res.body as ProductsResponse;

    expect(products.length).toBeGreaterThan(0);
    for (const product of products) {
      expect(Object.keys(product).sort()).toEqual(['availableUnits', 'id', 'name', 'pricePaise']);
      expect(product.id).toMatch(UUID);
      expect(Number.isInteger(product.pricePaise)).toBe(true);
      expect(product.pricePaise).toBeGreaterThan(0);
      expect(Number.isInteger(product.availableUnits)).toBe(true);
      expect(product.availableUnits).toBeGreaterThanOrEqual(0);
    }
  });

  it('reports availableUnits equal to stock in the database (no reservations yet)', async () => {
    await pool.query(
      "INSERT INTO products (name, price_paise, stock_quantity) VALUES ('Sold Out Ladoo', 1000, 0)",
    );

    const res = await request(app).get('/products');

    expect((res.body as ProductsResponse).products).toEqual([
      expect.objectContaining({ name: 'Sold Out Ladoo', pricePaise: 1000, availableUnits: 0 }),
    ]);
  });
});

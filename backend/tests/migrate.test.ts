import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';

// Runs one INSERT inside a transaction that is always rolled back, and returns
// the PostgreSQL error code (or null if the insert succeeded).
async function insertProductErrorCode(values: unknown[]): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO products (name, price_paise, stock_quantity) VALUES ($1, $2, $3)',
      values,
    );
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('migration runner (real PostgreSQL)', () => {
  it('applies every migration to the freshly rebuilt test database', async () => {
    // globalSetup dropped the schema and ran all migrations from scratch.
    const { rows } = await pool.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY name',
    );
    expect(rows.map((row) => row.name)).toEqual([
      '0001_baseline.sql',
      '0002_create_products.sql',
      '0003_create_orders.sql',
    ]);
  });

  it('is idempotent and safe to run concurrently', async () => {
    // Everything is already applied, so nothing new should run, and the
    // advisory lock must let parallel runs finish without errors.
    const results = await Promise.all([runMigrations(pool), runMigrations(pool)]);
    expect(results).toEqual([[], []]);
  });
});

describe('products table constraints', () => {
  it('stores money and stock as integer columns', async () => {
    const { rows } = await pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'products' AND column_name IN ('price_paise', 'stock_quantity')
        ORDER BY column_name`,
    );
    expect(rows).toEqual([
      { column_name: 'price_paise', data_type: 'integer' },
      { column_name: 'stock_quantity', data_type: 'integer' },
    ]);
  });

  it('accepts a valid product', async () => {
    expect(await insertProductErrorCode(['Kachori', 2000, 0])).toBeNull();
  });

  it.each([
    ['zero price', ['Kachori', 0, 5], '23514'],
    ['negative price', ['Kachori', -100, 5], '23514'],
    ['fractional paise', ['Kachori', 10.5, 5], '22P02'],
    ['negative stock', ['Kachori', 2000, -1], '23514'],
    ['blank name', ['   ', 2000, 5], '23514'],
    ['missing name', [null, 2000, 5], '23502'],
  ])('rejects %s', async (_label, values, expectedCode) => {
    expect(await insertProductErrorCode(values)).toBe(expectedCode);
  });

  it('rejects duplicate names regardless of case', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "INSERT INTO products (name, price_paise, stock_quantity) VALUES ('Dhokla', 3000, 5)",
      );
      await expect(
        client.query(
          "INSERT INTO products (name, price_paise, stock_quantity) VALUES ('DHOKLA', 3000, 5)",
        ),
      ).rejects.toMatchObject({ code: '23505' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('updates updated_at automatically', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO products (name, price_paise, stock_quantity, created_at, updated_at)
         VALUES ('Dhokla', 3000, 5, now() - interval '1 day', now() - interval '1 day')
         RETURNING id`,
      );
      const updated = await client.query<{ fresh: boolean }>(
        `UPDATE products SET stock_quantity = 4 WHERE id = $1
         RETURNING updated_at > created_at AS fresh`,
        [rows[0]?.id],
      );
      expect(updated.rows[0]?.fresh).toBe(true);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

import type { Pool } from 'pg';

export type SeedProduct = {
  id: string;
  name: string;
  pricePaise: number;
  stockQuantity: number;
};

// Fixed IDs make the seed idempotent: re-running it recognises existing rows.
export const SEED_PRODUCTS: readonly SeedProduct[] = [
  { id: 'a1b2c3d4-0001-4000-8000-000000000001', name: 'Samosa', pricePaise: 2000, stockQuantity: 40 },
  { id: 'a1b2c3d4-0002-4000-8000-000000000002', name: 'Vada Pav', pricePaise: 2500, stockQuantity: 30 },
  { id: 'a1b2c3d4-0003-4000-8000-000000000003', name: 'Paneer Puff', pricePaise: 3500, stockQuantity: 20 },
  { id: 'a1b2c3d4-0004-4000-8000-000000000004', name: 'Masala Peanuts', pricePaise: 1500, stockQuantity: 50 },
  { id: 'a1b2c3d4-0005-4000-8000-000000000005', name: 'Chocolate Brownie', pricePaise: 6000, stockQuantity: 12 },
];

// Only local development and test databases may be seeded.
const SEEDABLE_DATABASE = /^pickup_counter$|_dev$|_test$/;

export function assertSeedTargetAllowed(databaseName: string, nodeEnv: string): void {
  if (nodeEnv === 'production') {
    throw new Error('Refusing to seed: NODE_ENV is "production".');
  }
  if (!SEEDABLE_DATABASE.test(databaseName)) {
    throw new Error(
      `Refusing to seed database "${databaseName}": only "pickup_counter" or names ending in "_dev"/"_test" are allowed.`,
    );
  }
}

/**
 * Inserts the development snack catalog. Safe to run repeatedly: rows that
 * already exist (same id or same name) are left untouched, so live stock
 * levels are never overwritten.
 *
 * Returns how many products were newly inserted.
 */
export async function runSeed(pool: Pool, nodeEnv: string): Promise<number> {
  // Check the database we are actually connected to, not just the URL.
  const { rows } = await pool.query<{ name: string }>('SELECT current_database() AS name');
  assertSeedTargetAllowed(rows[0]?.name ?? '', nodeEnv);

  const result = await pool.query(
    `INSERT INTO products (id, name, price_paise, stock_quantity)
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::int[], $4::int[])
     ON CONFLICT DO NOTHING`,
    [
      SEED_PRODUCTS.map((p) => p.id),
      SEED_PRODUCTS.map((p) => p.name),
      SEED_PRODUCTS.map((p) => p.pricePaise),
      SEED_PRODUCTS.map((p) => p.stockQuantity),
    ],
  );
  return result.rowCount ?? 0;
}

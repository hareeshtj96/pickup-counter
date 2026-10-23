import { pool } from '../db/pool.js';

export type Product = {
  id: string;
  name: string;
  /** Price in integer paise (Rs 1 = 100 paise). */
  pricePaise: number;
  /** Units a customer can still buy. */
  availableUnits: number;
};

type ProductRow = {
  id: string;
  name: string;
  price_paise: number;
  available_units: number;
};

export async function listProducts(): Promise<Product[]> {
  // Phase 2: nothing is reserved yet, so every unit in stock is available.
  // Phase 3 will subtract active reservations here, in SQL.
  const { rows } = await pool.query<ProductRow>(
    `SELECT id, name, price_paise, stock_quantity AS available_units
       FROM products
      ORDER BY name ASC, id ASC`,
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    pricePaise: row.price_paise,
    availableUnits: row.available_units,
  }));
}

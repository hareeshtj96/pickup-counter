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
  // Physical stock minus active reservations (unexpired pending + paid,
  // uncollected orders), as defined once in the product_availability view.
  const { rows } = await pool.query<ProductRow>(
    `SELECT p.id, p.name, p.price_paise, a.available_units
       FROM products p
       JOIN product_availability a ON a.product_id = p.id
      ORDER BY p.name ASC, p.id ASC`,
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    pricePaise: row.price_paise,
    availableUnits: row.available_units,
  }));
}

import type { Request, Response } from 'express';
import { listProducts } from '../services/products.service.js';

export async function getProducts(_req: Request, res: Response): Promise<void> {
  const products = await listProducts();
  res.json({ products });
}

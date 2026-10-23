import { Router } from 'express';
import { getProducts } from '../controllers/products.controller.js';

export const productsRouter = Router();

productsRouter.get('/', getProducts);

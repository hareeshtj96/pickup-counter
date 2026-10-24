import { Router } from 'express';
import { healthRouter } from './health.routes.js';
import { ordersRouter } from './orders.routes.js';
import { paymentsRouter } from './payments.routes.js';
import { productsRouter } from './products.routes.js';

export function createRouter(): Router {
  const routes = Router();
  routes.use('/health', healthRouter);
  routes.use('/products', productsRouter);
  routes.use('/orders', ordersRouter);
  routes.use('/payments', paymentsRouter);

  // The frontend calls everything under /api (proxied by Vite). The same routes
  // are also served at the root, e.g. GET /health for Docker health checks and
  // GET /products as specified.
  const router = Router();
  router.use('/api', routes);
  router.use(routes);
  return router;
}

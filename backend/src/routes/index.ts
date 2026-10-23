import { Router } from 'express';
import { healthRouter } from './health.routes.js';
import { productsRouter } from './products.routes.js';

export function createRouter(): Router {
  const routes = Router();
  routes.use('/health', healthRouter);
  routes.use('/products', productsRouter);

  // The frontend calls everything under /api (proxied by Vite). The same routes
  // are also served at the root, e.g. GET /health for Docker health checks and
  // GET /products as specified.
  const router = Router();
  router.use('/api', routes);
  router.use(routes);
  return router;
}

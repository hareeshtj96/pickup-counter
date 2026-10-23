import { Router } from 'express';
import { healthRouter } from './health.routes.js';

export function createRouter(): Router {
  const router = Router();

  // Used by Docker health checks and monitoring.
  router.use('/health', healthRouter);

  // Everything the frontend calls lives under /api. Feature routers
  // (products, orders, ...) will be mounted here in later phases.
  const api = Router();
  api.use('/health', healthRouter);
  router.use('/api', api);

  return router;
}

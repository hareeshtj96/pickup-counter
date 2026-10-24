import express, { type Express } from 'express';
import { env } from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { type RouterOptions, createRouter } from './routes/index.js';

// Signed webhooks must be verified against the exact bytes received, so these
// paths get the unparsed body (a Buffer) before express.json() can consume it.
// They are parsed as JSON only after the signature check passes.
const RAW_BODY_PATHS = ['/payments/webhook', '/api/payments/webhook'];

/**
 * Builds the Express application without starting a server, so tests can use
 * it directly with Supertest. Options default to the validated environment.
 */
export function createApp(
  options: RouterOptions = { devPaymentSimulator: env.DEV_PAYMENT_SIMULATOR },
): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(RAW_BODY_PATHS, express.raw({ type: () => true, limit: '64kb' }));
  app.use(express.json({ limit: '100kb' }));

  app.use(createRouter(options));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

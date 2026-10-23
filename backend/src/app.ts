import express, { type Express } from 'express';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { createRouter } from './routes/index.js';

/**
 * Builds the Express application without starting a server, so tests can use
 * it directly with Supertest.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.use(createRouter());

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

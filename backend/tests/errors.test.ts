import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { validate } from '../src/middleware/validate.js';

type ErrorResponse = {
  error: { code: string; message: string; details?: { path: string; message: string }[] };
};

// A tiny app that exercises the shared middleware in isolation.
function buildApp() {
  const app = express();
  app.use(express.json());

  app.post(
    '/echo',
    validate({ body: z.object({ quantity: z.number().int().positive() }) }),
    (_req, res) => {
      res.json(res.locals.validated);
    },
  );

  app.get('/boom', () => {
    throw new Error('database password is hunter2');
  });

  app.use(errorHandler);
  return app;
}

describe('validate middleware', () => {
  it('passes parsed input to the handler', async () => {
    const res = await request(buildApp()).post('/echo').send({ quantity: 2 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ body: { quantity: 2 } });
  });

  it('rejects invalid input with 400 and field details', async () => {
    const res = await request(buildApp()).post('/echo').send({ quantity: -1 });
    const body = res.body as ErrorResponse;
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details?.[0]?.path).toBe('body.quantity');
  });
});

describe('error handler', () => {
  it('returns 400 for malformed JSON', async () => {
    const res = await request(buildApp())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{"quantity":');
    expect(res.status).toBe(400);
    expect((res.body as ErrorResponse).error.code).toBe('INVALID_JSON');
  });

  it('hides internal error details and stack traces', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(buildApp()).get('/boom');
    consoleError.mockRestore();

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' },
    });
    expect(res.text).not.toContain('hunter2');
    expect(res.text).not.toContain('at ');
  });
});

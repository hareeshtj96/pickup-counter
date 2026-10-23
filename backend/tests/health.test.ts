import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const app = createApp();

describe('health endpoints (real PostgreSQL)', () => {
  it.each(['/health', '/api/health'])('GET %s returns 200 with the database up', async (path) => {
    const res = await request(app).get(path);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toMatchObject({ status: 'ok', database: 'up' });
    expect(typeof (res.body as { timestamp?: unknown }).timestamp).toBe('string');
  });

  it('does not advertise the framework', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('unknown routes', () => {
  it('returns a 404 JSON error', async () => {
    const res = await request(app).get('/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route GET /api/does-not-exist not found.' },
    });
  });
});

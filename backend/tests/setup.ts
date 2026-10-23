import { afterAll } from 'vitest';
import { closePool } from '../src/db/pool.js';

// Each test file gets its own module instance of the pool; close it afterwards
// so Vitest does not hang on open database connections.
afterAll(async () => {
  await closePool();
});

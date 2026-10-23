import { env } from '../../config/env.js';
import { closePool, pool } from '../pool.js';
import { runSeed } from '../seed.js';

try {
  const inserted = await runSeed(pool, env.NODE_ENV);
  console.log(`Seed complete: ${inserted} new product(s) inserted.`);
} catch (err) {
  console.error('Seed failed:', err);
  process.exitCode = 1;
} finally {
  await closePool();
}

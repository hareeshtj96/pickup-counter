import { closePool, pool } from '../pool.js';
import { runSeed } from '../seed.js';

try {
  await runSeed(pool);
  console.log('Seed complete.');
} catch (err) {
  console.error('Seed failed:', err);
  process.exitCode = 1;
} finally {
  await closePool();
}

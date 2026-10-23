import { closePool, pool } from '../pool.js';
import { runMigrations } from '../migrate.js';

try {
  const applied = await runMigrations(pool);
  console.log(
    applied.length > 0
      ? `Applied migrations: ${applied.join(', ')}`
      : 'Database schema is up to date.',
  );
} catch (err) {
  console.error('Migration failed:', err);
  process.exitCode = 1;
} finally {
  await closePool();
}

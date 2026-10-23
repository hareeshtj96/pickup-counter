import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import {
  acquireTestRunLock,
  releaseTestRunLock,
  resetTestSchema,
  resolveTestDatabaseConfig,
  verifyTestDatabase,
} from './helpers/testDatabase.js';

/**
 * Runs once, in the main Vitest process, before any test file.
 *
 * 1. Validates TEST_DATABASE_URL (no connection is opened if it is unsafe).
 * 2. Opens ONE dedicated connection and verifies it is the marked test DB.
 * 3. Takes the test-run advisory lock on that connection.
 * 4. Rebuilds the schema and runs all migrations.
 *
 * The dedicated connection stays open until the returned teardown runs after
 * the last test file. Advisory locks belong to the session, so keeping this
 * connection open is what keeps the lock held for the whole run; if the
 * process dies, the connection drops and PostgreSQL releases the lock.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const config = resolveTestDatabaseConfig(process.env);

  const lockClient = new pg.Client({ connectionString: config.url });
  lockClient.on('error', (err) => {
    console.error('Test-run lock connection lost; the lock is no longer held:', err.message);
  });
  await lockClient.connect();

  try {
    await verifyTestDatabase(lockClient);
    await acquireTestRunLock(lockClient);
    await resetTestSchema(lockClient);

    const migrationPool = new pg.Pool({ connectionString: config.url, max: 1 });
    try {
      await runMigrations(migrationPool);
    } finally {
      await migrationPool.end();
    }
  } catch (err) {
    // Closing the session also releases the lock if it was taken.
    await lockClient.end().catch(() => undefined);
    throw err;
  }

  return async () => {
    try {
      await releaseTestRunLock(lockClient);
    } finally {
      await lockClient.end();
    }
  };
}

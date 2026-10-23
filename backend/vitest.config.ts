import { defineConfig } from 'vitest/config';
import { resolveTestDatabaseConfig } from './tests/helpers/testDatabase.js';

// Integration tests run against a real PostgreSQL database, never a mock.
// Fails closed before any test starts if TEST_DATABASE_URL is missing or does
// not point at the project's test database. DATABASE_URL is never used as a
// fallback; it is overwritten below so application code also uses the test DB.
const testDatabase = resolveTestDatabaseConfig(process.env);

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testDatabase.url,
      // The concurrency test holds 10 simultaneous order transactions open;
      // leave headroom for the test's own queries.
      DB_POOL_MAX: '20',
    },
    globalSetup: ['tests/globalSetup.ts'],
    setupFiles: ['tests/setup.ts'],
    // Test files share one database, so run them one at a time.
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});

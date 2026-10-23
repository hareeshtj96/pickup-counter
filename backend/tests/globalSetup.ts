import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';

// Runs once before all test files: bring the real test database schema up to date.
export default async function setup(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

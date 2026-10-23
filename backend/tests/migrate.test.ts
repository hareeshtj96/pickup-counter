import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';

describe('migration runner (real PostgreSQL)', () => {
  it('records applied migrations', async () => {
    const { rows } = await pool.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY name',
    );
    expect(rows.map((row) => row.name)).toContain('0001_baseline.sql');
  });

  it('is idempotent and safe to run concurrently', async () => {
    // globalSetup already migrated, so nothing new should be applied, and the
    // advisory lock must let parallel runs finish without errors.
    const results = await Promise.all([runMigrations(pool), runMigrations(pool)]);
    expect(results).toEqual([[], []]);
  });
});

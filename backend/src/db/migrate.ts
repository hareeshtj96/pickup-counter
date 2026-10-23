import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

// backend/migrations — the same relative location from src/db and dist/db.
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

// Arbitrary constant used as the advisory lock key, so two processes starting at
// the same time cannot apply migrations concurrently.
const MIGRATION_LOCK_ID = 727_001;

/**
 * Applies every `.sql` file in `dir` that has not been applied yet, in filename
 * order. Each file runs in its own transaction together with the bookkeeping
 * insert, so a failed migration leaves no partial changes behind.
 *
 * Returns the names of the migrations applied by this call.
 */
export async function runMigrations(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.name));

    const files = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
    const newlyApplied: string[] = [];

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        newlyApplied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed`, { cause: err });
      }
    }

    return newlyApplied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

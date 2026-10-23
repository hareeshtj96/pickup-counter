import pg from 'pg';
import { env } from '../config/env.js';

// One shared connection pool for the whole process. PostgreSQL is the source of
// truth, so every request borrows a connection from here and returns it.
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

// An idle client can lose its connection (e.g. the database restarts). Without
// this listener that error would crash the process.
pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err.message);
});

let closed = false;

export async function closePool(): Promise<void> {
  if (closed) return;
  closed = true;
  await pool.end();
}

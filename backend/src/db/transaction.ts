import type { PoolClient } from 'pg';

/** PostgreSQL SQLSTATE codes the services react to. */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_LOCK_NOT_AVAILABLE = '55P03';

export function isPgError(err: unknown): err is { code: string; constraint?: string } {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string';
}

/** Returns false if the connection could not be rolled back (and must be discarded). */
export async function rollback(client: PoolClient): Promise<boolean> {
  try {
    await client.query('ROLLBACK');
    return true;
  } catch {
    return false;
  }
}

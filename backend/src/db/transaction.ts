import type { PoolClient } from 'pg';

/** PostgreSQL SQLSTATE codes the services react to. */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_LOCK_NOT_AVAILABLE = '55P03';
export const PG_DEADLOCK_DETECTED = '40P01';

export function isPgError(err: unknown): err is { code: string; constraint?: string } {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string';
}

/**
 * True when a transaction failed only because of lock contention: a lock wait
 * exceeded lock_timeout, or PostgreSQL broke a deadlock by aborting it. The
 * transaction has been rolled back entirely, so the client may safely retry;
 * services report this as a 503 "busy" error without database details.
 */
export function isLockContention(err: unknown): boolean {
  return isPgError(err) && (err.code === PG_LOCK_NOT_AVAILABLE || err.code === PG_DEADLOCK_DETECTED);
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

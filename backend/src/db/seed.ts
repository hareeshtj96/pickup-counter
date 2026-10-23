import type { Pool } from 'pg';

/**
 * Inserts development sample data. Intentionally empty in Phase 1: there are no
 * domain tables yet. Products will be seeded here in Phase 2.
 */
export function runSeed(_pool: Pool): Promise<void> {
  return Promise.resolve();
}

import { pool } from '../db/pool.js';

export type HealthReport = {
  status: 'ok' | 'error';
  database: 'up' | 'down';
  timestamp: string;
};

export async function getHealthReport(): Promise<HealthReport> {
  let databaseUp = false;
  try {
    await pool.query('SELECT 1');
    databaseUp = true;
  } catch (err) {
    console.error('Health check: database unreachable:', err instanceof Error ? err.message : err);
  }

  return {
    status: databaseUp ? 'ok' : 'error',
    database: databaseUp ? 'up' : 'down',
    timestamp: new Date().toISOString(),
  };
}

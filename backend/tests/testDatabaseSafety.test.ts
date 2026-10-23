import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool.js';
import {
  TEST_DATABASE_MARKER,
  TEST_RUN_LOCK_ID,
  acquireTestRunLock,
  resetDomainTables,
  resetTestSchema,
  resolveTestDatabaseConfig,
  verifyTestDatabase,
} from './helpers/testDatabase.js';

const PASSWORD = 's3cret-pw';
const VALID_DOCKER_URL = `postgres://pickup:${PASSWORD}@db:5432/pickup_counter_test`;

const liveConfig = resolveTestDatabaseConfig(process.env);

/** Same server and credentials as the test DB, different database name. */
function urlForDatabase(name: string): string {
  const url = new URL(liveConfig.url);
  url.pathname = `/${name}`;
  return url.toString();
}

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function sqlSent(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
}

describe('resolveTestDatabaseConfig (no connection opened)', () => {
  it.each([
    ['missing configuration', {}, /TEST_DATABASE_URL is not set/],
    [
      'only DATABASE_URL set (no fallback)',
      { DATABASE_URL: `postgres://pickup:${PASSWORD}@db:5432/pickup_counter_test` },
      /TEST_DATABASE_URL is not set/,
    ],
    ['empty value', { TEST_DATABASE_URL: '' }, /TEST_DATABASE_URL is not set/],
    ['unparseable URL', { TEST_DATABASE_URL: 'not a url' }, /not a valid URL/],
    ['wrong scheme', { TEST_DATABASE_URL: `mysql://pickup:${PASSWORD}@db:3306/pickup_counter_test` }, /postgres:\/\//],
    [
      'development database name',
      { TEST_DATABASE_URL: `postgres://pickup:${PASSWORD}@db:5432/pickup_counter` },
      /database name must be "pickup_counter_test"/,
    ],
    [
      'look-alike name',
      { TEST_DATABASE_URL: `postgres://pickup:${PASSWORD}@db:5432/prod_pickup_counter_test` },
      /database name must be/,
    ],
    [
      'remote host',
      { TEST_DATABASE_URL: `postgres://pickup:${PASSWORD}@prod.example.com:5432/pickup_counter_test` },
      /host:port must be one of/,
    ],
    [
      'the separate local PostgreSQL on localhost:5432',
      { TEST_DATABASE_URL: `postgres://pickup:${PASSWORD}@localhost:5432/pickup_counter_test` },
      /host:port must be one of/,
    ],
    [
      'Docker service on a non-container port',
      { TEST_DATABASE_URL: `postgres://pickup:${PASSWORD}@db:5433/pickup_counter_test` },
      /host:port must be one of/,
    ],
    [
      'query parameters that could redirect the connection',
      { TEST_DATABASE_URL: `${VALID_DOCKER_URL}?host=prod.example.com` },
      /must not contain query parameters/,
    ],
  ])('rejects %s', (_label, source, message) => {
    expect(() => resolveTestDatabaseConfig(source)).toThrow(message);
  });

  it('never includes credentials in error messages', () => {
    const unsafe = [
      `postgres://pickup:${PASSWORD}@prod.example.com:5432/pickup_counter_test`,
      `postgres://pickup:${PASSWORD}@db:5432/pickup_counter`,
      `${VALID_DOCKER_URL}?sslmode=disable`,
    ];
    for (const url of unsafe) {
      let message = '';
      try {
        resolveTestDatabaseConfig({ TEST_DATABASE_URL: url });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(PASSWORD);
    }
  });

  it.each([
    ['the Compose service', {}, VALID_DOCKER_URL],
    ['localhost on the default host port', {}, `postgres://pickup:${PASSWORD}@localhost:5433/pickup_counter_test`],
    [
      '127.0.0.1 on a custom POSTGRES_HOST_PORT',
      { POSTGRES_HOST_PORT: '6543' },
      `postgresql://pickup:${PASSWORD}@127.0.0.1:6543/pickup_counter_test`,
    ],
  ])('accepts %s', (_label, extra, url) => {
    const config = resolveTestDatabaseConfig({ ...extra, TEST_DATABASE_URL: url });
    expect(config).toMatchObject({ database: 'pickup_counter_test', url });
  });
});

describe('verifyTestDatabase (real PostgreSQL)', () => {
  it('accepts the configured, marked test database', async () => {
    await withClient(liveConfig.url, (client) => verifyTestDatabase(client));
  });

  it('rejects a database whose name matches but which has no marker', async () => {
    // "postgres" exists on every server and is never marked.
    await withClient(urlForDatabase('postgres'), async (client) => {
      await expect(
        verifyTestDatabase(client, { database: 'postgres', marker: TEST_DATABASE_MARKER }),
      ).rejects.toThrow(/not marked as a disposable test database/);
    });
  });
});

describe('destructive helpers refuse unverified databases', () => {
  it('does not send DROP SCHEMA to the development database', async () => {
    await withClient(urlForDatabase('pickup_counter'), async (client) => {
      const query = vi.spyOn(client, 'query');

      await expect(resetTestSchema(client)).rejects.toThrow(/expected "pickup_counter_test"/);

      expect(sqlSent(query).some((sql) => /\b(DROP|CREATE|TRUNCATE)\b/i.test(sql))).toBe(false);
      query.mockRestore();

      // The development schema is still intact.
      const { rows } = await client.query<{ exists: boolean }>(
        "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
      );
      expect(rows[0]?.exists).toBe(true);
    });
  });

  it('does not send DROP SCHEMA to an unmarked database', async () => {
    await withClient(urlForDatabase('postgres'), async (client) => {
      const query = vi.spyOn(client, 'query');
      await expect(resetTestSchema(client)).rejects.toThrow(/Refusing destructive test setup/);
      expect(sqlSent(query).some((sql) => /\bDROP\b/i.test(sql))).toBe(false);
      query.mockRestore();
    });
  });

  describe('resetDomainTables', () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    afterEach(() => {
      process.env.DATABASE_URL = originalDatabaseUrl;
    });

    it('refuses when the app pool is not configured for the test database', async () => {
      process.env.DATABASE_URL = urlForDatabase('pickup_counter');
      const connect = vi.spyOn(pool, 'connect');

      await expect(resetDomainTables(pool)).rejects.toThrow(/not the verified TEST_DATABASE_URL/);

      expect(connect).not.toHaveBeenCalled();
      connect.mockRestore();
    });

    it('empties application tables but keeps migration history', async () => {
      await pool.query(
        "INSERT INTO products (name, price_paise, stock_quantity) VALUES ('Cleanup Probe', 100, 1)",
      );

      await resetDomainTables(pool);

      const { rows } = await pool.query<{ products: number; migrations: number }>(
        `SELECT (SELECT count(*)::int FROM products) AS products,
                (SELECT count(*)::int FROM schema_migrations) AS migrations`,
      );
      expect(rows[0]).toEqual({ products: 0, migrations: 2 });
    });
  });
});

describe('test-run lock', () => {
  it('is held by the current run for its whole duration', async () => {
    const { rows } = await pool.query<{ holders: number }>(
      `SELECT count(*)::int AS holders FROM pg_locks
        WHERE locktype = 'advisory' AND objid = $1 AND granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      [TEST_RUN_LOCK_ID],
    );
    expect(rows[0]?.holders).toBe(1);
  });

  it('makes a second, overlapping run fail before touching the database', async () => {
    await withClient(liveConfig.url, async (client) => {
      await expect(acquireTestRunLock(client)).rejects.toThrow(/Another test run is using the test database/);
    });
  });
});

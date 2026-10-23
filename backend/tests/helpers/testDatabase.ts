import pg from 'pg';

/**
 * Safety layer for the destructive parts of the test suite (schema reset and
 * table cleanup). Everything here fails closed: if any check cannot prove we
 * are talking to the disposable test database, it throws before running
 * destructive SQL.
 *
 * Layers:
 *  1. Config check (no connection yet): TEST_DATABASE_URL must be set
 *     explicitly, use postgres://, name exactly `pickup_counter_test`, point at
 *     an allowed host:port, and carry no query-string overrides.
 *  2. Identity check (on the live connection that will run the destructive
 *     SQL): current_database() must match, and the database must carry the
 *     marker comment set by docker/postgres/init/01-create-test-db.sql.
 *  3. Test-run lock: a session advisory lock held for the whole run, so two
 *     runs can never reset the same database underneath each other.
 *
 * Error messages identify a target as host:port/database only, never the full
 * URL, so credentials are not leaked.
 */

export const TEST_DATABASE_NAME = 'pickup_counter_test';
export const TEST_DATABASE_MARKER = 'pickup-counter:disposable-test-database';

// Advisory lock keys share one space per database. 727001 is the migration lock.
export const TEST_RUN_LOCK_ID = 727_002;

const COMPOSE_INTERNAL_ENDPOINT = { host: 'db', port: 5432 };
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const DEFAULT_POSTGRES_HOST_PORT = 5433;

export class TestDatabaseSafetyError extends Error {
  override readonly name = 'TestDatabaseSafetyError';
}

export type TestDatabaseConfig = {
  url: string;
  host: string;
  port: number;
  database: string;
};

type Endpoint = { host: string; port: number };

function describeEndpoint({ host, port }: Endpoint): string {
  return `${host}:${port}`;
}

/** Host:port pairs where the project's test database may live. */
export function allowedTestEndpoints(source: NodeJS.ProcessEnv): Endpoint[] {
  const hostPort = Number(source.POSTGRES_HOST_PORT ?? DEFAULT_POSTGRES_HOST_PORT);
  if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
    throw new TestDatabaseSafetyError('POSTGRES_HOST_PORT must be a valid port number.');
  }
  return [COMPOSE_INTERNAL_ENDPOINT, ...LOOPBACK_HOSTS.map((host) => ({ host, port: hostPort }))];
}

/**
 * Layer 1: validates TEST_DATABASE_URL without connecting. Never falls back to
 * DATABASE_URL.
 */
export function resolveTestDatabaseConfig(source: NodeJS.ProcessEnv): TestDatabaseConfig {
  const raw = source.TEST_DATABASE_URL;
  if (!raw) {
    throw new TestDatabaseSafetyError(
      'TEST_DATABASE_URL is not set. Integration tests never fall back to DATABASE_URL (see README "Tests").',
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TestDatabaseSafetyError('TEST_DATABASE_URL is not a valid URL.');
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new TestDatabaseSafetyError('TEST_DATABASE_URL must start with postgres:// or postgresql://.');
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const endpoint = { host: url.hostname, port: url.port ? Number(url.port) : 5432 };
  const target = `${describeEndpoint(endpoint)}/${database}`;

  // node-postgres applies query parameters (e.g. ?host=...) to the connection,
  // which could silently redirect it, so none are allowed.
  if (url.search !== '') {
    throw new TestDatabaseSafetyError(
      `Refusing test database ${target}: TEST_DATABASE_URL must not contain query parameters.`,
    );
  }

  if (database !== TEST_DATABASE_NAME) {
    throw new TestDatabaseSafetyError(
      `Refusing test database ${target}: the database name must be "${TEST_DATABASE_NAME}".`,
    );
  }

  const allowed = allowedTestEndpoints(source);
  if (!allowed.some((e) => e.host === endpoint.host && e.port === endpoint.port)) {
    throw new TestDatabaseSafetyError(
      `Refusing test database ${target}: host:port must be one of ${allowed.map(describeEndpoint).join(', ')}.`,
    );
  }

  return { url: raw, host: endpoint.host, port: endpoint.port, database };
}

/**
 * Layer 2: proves the live connection is the marked test database. Must run on
 * the same connection that will execute destructive SQL.
 */
export async function verifyTestDatabase(
  client: pg.ClientBase,
  expected: { database: string; marker: string } = {
    database: TEST_DATABASE_NAME,
    marker: TEST_DATABASE_MARKER,
  },
): Promise<void> {
  const { rows } = await client.query<{ name: string; marker: string | null }>(
    `SELECT current_database() AS name,
            shobj_description(oid, 'pg_database') AS marker
       FROM pg_database
      WHERE datname = current_database()`,
  );
  const row = rows[0];

  if (row?.name !== expected.database) {
    throw new TestDatabaseSafetyError(
      `Refusing destructive test setup: connected to database "${row?.name ?? 'unknown'}", expected "${expected.database}".`,
    );
  }
  if (row.marker !== expected.marker) {
    throw new TestDatabaseSafetyError(
      `Refusing destructive test setup: database "${row.name}" is not marked as a disposable test database (see README "Tests" to mark it).`,
    );
  }
}

/** Layer 3: take the test-run lock on `client`, or fail immediately if another run holds it. */
export async function acquireTestRunLock(client: pg.ClientBase): Promise<void> {
  const { rows } = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS locked',
    [TEST_RUN_LOCK_ID],
  );
  if (rows[0]?.locked !== true) {
    throw new TestDatabaseSafetyError(
      'Another test run is using the test database (advisory lock is held). Wait for it to finish, then retry.',
    );
  }
}

export async function releaseTestRunLock(client: pg.ClientBase): Promise<void> {
  await client.query('SELECT pg_advisory_unlock($1)', [TEST_RUN_LOCK_ID]);
}

/** Drops and recreates the public schema, only after verifying the connection. */
export async function resetTestSchema(client: pg.ClientBase): Promise<void> {
  await verifyTestDatabase(client);
  await client.query('DROP SCHEMA public CASCADE');
  await client.query('CREATE SCHEMA public');
}

/**
 * Empties every application table (all of public except schema_migrations) in
 * one TRUNCATE, so foreign keys between them never block the cleanup. New
 * tables added by future migrations are picked up automatically.
 *
 * `pool` is the application pool; the test process must have pointed it at
 * TEST_DATABASE_URL, and the connection is verified before truncating.
 */
export async function resetDomainTables(pool: pg.Pool): Promise<void> {
  const config = resolveTestDatabaseConfig(process.env);
  if (process.env.DATABASE_URL !== config.url) {
    throw new TestDatabaseSafetyError(
      'Refusing to reset tables: DATABASE_URL in the test process is not the verified TEST_DATABASE_URL.',
    );
  }

  const client = await pool.connect();
  try {
    await verifyTestDatabase(client);
    const { rows } = await client.query<{ tables: string | null }>(
      `SELECT string_agg(format('%I.%I', schemaname, tablename), ', ' ORDER BY tablename) AS tables
         FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
    );
    // Identifiers come from the catalog and are quoted by format('%I').
    const tables = rows[0]?.tables;
    if (tables) {
      await client.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY`);
    }
  } finally {
    client.release();
  }
}

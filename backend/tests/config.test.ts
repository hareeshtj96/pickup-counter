import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestDatabaseConfig } from './helpers/testDatabase.js';

// In Docker the project files are mounted read-only at PROJECT_ROOT; on the
// host they are two levels up from backend/tests.
const projectRoot = process.env.PROJECT_ROOT ?? path.resolve(import.meta.dirname, '../..');
const compose = readFileSync(path.join(projectRoot, 'docker-compose.yml'), 'utf8');
const envExample = readFileSync(path.join(projectRoot, '.env.example'), 'utf8');

/** `${VAR:-default}` fallbacks used in docker-compose.yml. */
function composeDefaults(): Map<string, Set<string>> {
  const defaults = new Map<string, Set<string>>();
  for (const [, name, value] of compose.matchAll(/\$\{([A-Z0-9_]+):-([^}]*)\}/g)) {
    if (name === undefined || value === undefined) continue;
    const values = defaults.get(name) ?? new Set<string>();
    values.add(value);
    defaults.set(name, values);
  }
  return defaults;
}

/** KEY=VALUE lines from .env.example; commented-out examples included when asked. */
function envExampleValues(includeCommented: boolean): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of envExample.split(/\r?\n/)) {
    const match = (includeCommented ? /^#?\s*([A-Z0-9_]+)=(.*)$/ : /^([A-Z0-9_]+)=(.*)$/).exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) values.set(match[1], match[2].trim());
  }
  return values;
}

describe('.env.example agrees with docker-compose.yml defaults', () => {
  const defaults = composeDefaults();
  const example = envExampleValues(false);

  it('uses a single default per variable in docker-compose.yml', () => {
    for (const [name, values] of defaults) {
      expect([...values], name).toHaveLength(1);
    }
  });

  it('documents every Compose variable with the same value', () => {
    expect(defaults.size).toBeGreaterThan(0);
    for (const [name, values] of defaults) {
      expect(example.get(name), name).toBe([...values][0]);
    }
  });

  it('has example connection URLs that match the documented credentials and host port', () => {
    const all = envExampleValues(true);
    const user = example.get('POSTGRES_USER');
    const password = example.get('POSTGRES_PASSWORD');
    const port = example.get('POSTGRES_HOST_PORT');

    expect(all.get('DATABASE_URL')).toBe(
      `postgres://${user}:${password}@localhost:${port}/${example.get('POSTGRES_DB')}`,
    );
    expect(all.get('TEST_DATABASE_URL')).toBe(
      `postgres://${user}:${password}@localhost:${port}/pickup_counter_test`,
    );
  });

  it('documents a TEST_DATABASE_URL that passes the test-database safety checks', () => {
    const all = envExampleValues(true);
    expect(() =>
      resolveTestDatabaseConfig({
        TEST_DATABASE_URL: all.get('TEST_DATABASE_URL'),
        POSTGRES_HOST_PORT: example.get('POSTGRES_HOST_PORT'),
      }),
    ).not.toThrow();
  });

  it('configures the backend container with a TEST_DATABASE_URL on db:5432/pickup_counter_test', () => {
    const line = /TEST_DATABASE_URL:\s*(\S+)/.exec(compose)?.[1] ?? '';
    const resolved = line.replace(/\$\{([A-Z0-9_]+):-([^}]*)\}/g, (_m, _name: string, value: string) => value);
    expect(() => resolveTestDatabaseConfig({ TEST_DATABASE_URL: resolved })).not.toThrow();
    expect(resolved).toMatch(/@db:5432\/pickup_counter_test$/);
  });
});

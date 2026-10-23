import { z } from 'zod';

// Every environment variable the backend reads is declared and validated here.
// If something is missing or malformed the process stops immediately with a
// clear message, instead of failing later in a confusing way.
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z
    .string()
    .url()
    .refine((value) => /^postgres(ql)?:\/\//.test(value), 'must be a postgres:// URL'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10_000),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    // Only report variable names and problems, never the values (they may be secrets).
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}

export const env: Env = parseEnv(process.env);

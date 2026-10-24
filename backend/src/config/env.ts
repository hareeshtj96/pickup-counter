import { z } from 'zod';

// Every environment variable the backend reads is declared and validated here.
// If something is missing or malformed the process stops immediately with a
// clear message, instead of failing later in a confusing way.
const DEV_SECRET_PREFIX = 'dev-only-';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z
    .string()
    .url()
    .refine((value) => /^postgres(ql)?:\/\//.test(value), 'must be a postgres:// URL'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10_000),
  // How often the API persists 'expired' for overdue unpaid orders.
  ORDER_EXPIRY_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1000).default(15_000),
  // HMAC-SHA256 key shared with the payment provider. Required; no default.
  PAYMENT_WEBHOOK_SECRET: z.string().min(32, 'must be at least 32 characters'),
  // Registers POST /dev/orders/:id/simulate-payment for local demos. Off unless
  // explicitly "true"; refused in production.
  DEV_PAYMENT_SIMULATOR: z
    .enum(['true', 'false'], { errorMap: () => ({ message: 'must be "true" or "false"' }) })
    .default('false')
    .transform((value) => value === 'true'),
})
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === 'production' && value.DEV_PAYMENT_SIMULATOR) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DEV_PAYMENT_SIMULATOR'],
        message: 'the development payment simulator cannot be enabled in production',
      });
    }
    // The documented local placeholder must never reach production.
    if (value.NODE_ENV === 'production' && value.PAYMENT_WEBHOOK_SECRET.startsWith(DEV_SECRET_PREFIX)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PAYMENT_WEBHOOK_SECRET'],
        message: 'the development placeholder is not allowed in production',
      });
    }
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

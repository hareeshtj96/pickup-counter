import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';
import { AppError } from '../errors/AppError.js';

type RequestPart = 'body' | 'query' | 'params';
export type RequestSchemas = Partial<Record<RequestPart, ZodTypeAny>>;

/**
 * Validates the request against Zod schemas before the controller runs.
 * Invalid input is rejected with 400 VALIDATION_ERROR.
 *
 * Parsed (and coerced) values are stored on `res.locals.validated`, because in
 * Express 5 `req.query` is read-only. Controllers should read from there.
 */
export function validate(schemas: RequestSchemas): RequestHandler {
  return (req, res, next) => {
    const validated: Partial<Record<RequestPart, unknown>> = {};

    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part];
      if (!schema) continue;

      const result = schema.safeParse(req[part]);
      if (!result.success) {
        const details = result.error.issues.map((issue) => ({
          path: [part, ...issue.path].join('.'),
          message: issue.message,
        }));
        next(new AppError(400, 'VALIDATION_ERROR', 'Request validation failed.', details));
        return;
      }
      validated[part] = result.data;
    }

    res.locals.validated = validated;
    next();
  };
}

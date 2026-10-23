import type { ErrorRequestHandler } from 'express';
import { AppError } from '../errors/AppError.js';

type ErrorBody = { error: { code: string; message: string; details?: unknown } };

// Errors raised by express.json() carry a `type` such as "entity.parse.failed".
function bodyParserError(err: unknown): AppError | null {
  if (typeof err !== 'object' || err === null || !('type' in err)) return null;
  switch (err.type) {
    case 'entity.parse.failed':
      return new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
    case 'entity.too.large':
      return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
    default:
      return null;
  }
}

/**
 * Central error handler. Known errors become structured JSON responses;
 * unknown errors are logged server-side and returned as a generic 500 so stack
 * traces and internal details never reach customers.
 */
export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const known = err instanceof AppError ? err : bodyParserError(err);
  if (known) {
    const body: ErrorBody = { error: { code: known.code, message: known.message } };
    if (known.details !== undefined) body.error.details = known.details;
    res.status(known.statusCode).json(body);
    return;
  }

  console.error('Unhandled error:', err);
  const body: ErrorBody = {
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' },
  };
  res.status(500).json(body);
};

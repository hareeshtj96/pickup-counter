import type { RequestHandler } from 'express';
import { AppError } from '../errors/AppError.js';

/**
 * For routes that receive the raw body (see app.ts): parses the already
 * signature-verified bytes as JSON into req.body, and keeps the exact text on
 * res.locals.rawBody for auditing.
 */
export const parseRawJson: RequestHandler = (req, res, next) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  try {
    req.body = JSON.parse(raw) as unknown;
  } catch {
    next(new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON.'));
    return;
  }
  res.locals.rawBody = raw;
  next();
};

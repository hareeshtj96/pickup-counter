import type { RequestHandler } from 'express';
import { AppError } from '../errors/AppError.js';

/**
 * Rejects (415) any request whose Content-Type is not application/json.
 *
 * Used on state-changing POSTs that take no meaningful body. Without it they
 * would be CORS "simple requests" that another website could fire blindly from
 * a visitor's browser; requiring JSON forces a CORS preflight, which this API
 * does not grant to other origins.
 *
 * Reads the header directly rather than req.is(), which reports no type at all
 * for a request without a body.
 */
export const requireJson: RequestHandler = (req, _res, next) => {
  const mediaType = req.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    next(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.'));
    return;
  }
  next();
};

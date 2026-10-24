import type { RequestHandler } from 'express';
import { AppError } from '../errors/AppError.js';
import { SIGNATURE_HEADER, checkWebhookSignature } from '../payments/signature.js';

const REJECTIONS = {
  missing: ['SIGNATURE_MISSING', `Missing ${SIGNATURE_HEADER} header.`],
  malformed: ['SIGNATURE_MALFORMED', `${SIGNATURE_HEADER} must be "sha256=<64 hex characters>".`],
  invalid: ['SIGNATURE_INVALID', 'Webhook signature does not match.'],
} as const;

/**
 * Rejects the request (401) unless its X-Pickup-Signature header is a valid
 * HMAC-SHA256 of the raw body. Requires `express.raw()` to have stored the
 * unparsed body as a Buffer in `req.body` (see app.ts). Nothing about the
 * payment is looked at before this passes.
 */
export function verifyWebhookSignature(secret: string): RequestHandler {
  return (req, _res, next) => {
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = checkWebhookSignature(secret, rawBody, req.get(SIGNATURE_HEADER));

    if (result !== 'valid') {
      const [code, message] = REJECTIONS[result];
      next(new AppError(401, code, message));
      return;
    }
    next();
  };
}

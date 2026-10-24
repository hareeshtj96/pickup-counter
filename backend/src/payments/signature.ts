import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signature scheme:
 *
 *   X-Pickup-Signature: sha256=<64 lowercase hex characters>
 *
 * where the hex value is HMAC-SHA256(PAYMENT_WEBHOOK_SECRET, raw request body
 * bytes). The body is signed exactly as sent; it is never re-serialised.
 */
export const SIGNATURE_HEADER = 'x-pickup-signature';
const SIGNATURE_FORMAT = /^sha256=([0-9a-f]{64})$/;

export function signWebhookBody(secret: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export type SignatureCheck = 'valid' | 'missing' | 'malformed' | 'invalid';

export function checkWebhookSignature(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
): SignatureCheck {
  if (header === undefined || header === '') return 'missing';

  // Format and length are validated before any comparison.
  const hex = SIGNATURE_FORMAT.exec(header)?.[1];
  if (hex === undefined) return 'malformed';

  const provided = Buffer.from(hex, 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  if (provided.length !== expected.length) return 'malformed';

  return timingSafeEqual(provided, expected) ? 'valid' : 'invalid';
}

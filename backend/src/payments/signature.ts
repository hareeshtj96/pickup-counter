import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signature scheme:
 *
 *   X-Signature: <64 lowercase hex characters>
 *   X-Signature: sha256=<64 lowercase hex characters>     (also accepted)
 *
 * where the hex value is HMAC-SHA256(PAYMENT_WEBHOOK_SECRET, raw request body
 * bytes). The body is signed exactly as sent; it is never re-serialised.
 *
 * Both value forms are accepted because the original assignment's value format
 * could not be checked. They are validated identically and strictly: exactly 64
 * lowercase hex characters, an optional lowercase `sha256=` prefix, nothing else.
 * X-Signature is the only header read; any other signature header is ignored.
 */
export const SIGNATURE_HEADER = 'X-Signature';
const SIGNATURE_FORMAT = /^(?:sha256=)?([0-9a-f]{64})$/;

export type SignatureFormat = 'hex' | 'sha256';

/** Signs `rawBody`: the bare hex digest, or `sha256=` + hex digest. */
export function signWebhookBody(
  secret: string,
  rawBody: Buffer | string,
  format: SignatureFormat = 'hex',
): string {
  const hex = createHmac('sha256', secret).update(rawBody).digest('hex');
  return format === 'sha256' ? `sha256=${hex}` : hex;
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

/**
 * Sends a correctly signed payment webhook to the local API (development and
 * manual testing only).
 *
 *   npm run webhook:send -- --order <orderId> --amount <paise> [--status captured|failed]
 *                           [--event-id <id>] [--repeat <n>] [--url <webhook url>]
 *                           [--signature-format hex|sha256]
 *
 * The signature is sent in the X-Signature header: the bare hex HMAC-SHA256
 * digest (default, --signature-format hex) or `sha256=<hex>` (--signature-format
 * sha256). The server accepts both.
 *
 * Reads PAYMENT_WEBHOOK_SECRET from the environment; the secret is never printed.
 * Reuse --event-id, or pass --repeat 2, to resend the same event and observe
 * idempotency.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { SIGNATURE_HEADER, signWebhookBody } from '../src/payments/signature.js';

const USAGE =
  'Usage: npm run webhook:send -- --order <orderId> --amount <paise> [--status captured|failed] ' +
  '[--event-id <id>] [--repeat <n>] [--url <url>] [--signature-format hex|sha256]';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    order: { type: 'string' },
    amount: { type: 'string' },
    status: { type: 'string', default: 'captured' },
    'event-id': { type: 'string' },
    repeat: { type: 'string', default: '1' },
    url: { type: 'string', default: 'http://localhost:4000/payments/webhook' },
    'signature-format': { type: 'string', default: 'hex' },
  },
});

const secret = process.env.PAYMENT_WEBHOOK_SECRET;
if (!secret) fail('PAYMENT_WEBHOOK_SECRET is not set (see README "Payment webhook").');
if (!values.order || !values.amount) fail(USAGE);

const amountPaise = Number(values.amount);
if (!Number.isFinite(amountPaise)) fail('--amount must be a number of paise.');
const repeat = Number(values.repeat);
if (!Number.isInteger(repeat) || repeat < 1) fail('--repeat must be a positive integer.');

const format = values['signature-format'];
if (format !== 'hex' && format !== 'sha256') fail('--signature-format must be "hex" or "sha256".');

const eventId = values['event-id'] ?? `evt_${randomUUID()}`;
// Sign exactly the bytes that are sent.
const body = JSON.stringify({ eventId, orderId: values.order, amountPaise, status: values.status });
const signature = signWebhookBody(secret, body, format);

console.log(`POST ${values.url}  eventId=${eventId}  amountPaise=${amountPaise}  status=${values.status}`);

let failed = false;
for (let attempt = 1; attempt <= repeat; attempt++) {
  try {
    const response = await fetch(values.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [SIGNATURE_HEADER]: signature },
      body,
    });
    console.log(`[${attempt}/${repeat}] HTTP ${response.status} ${await response.text()}`);
    if (!response.ok) failed = true;
  } catch (err) {
    console.log(`[${attempt}/${repeat}] request failed: ${err instanceof Error ? err.message : String(err)}`);
    failed = true;
  }
}
process.exitCode = failed ? 1 : 0;

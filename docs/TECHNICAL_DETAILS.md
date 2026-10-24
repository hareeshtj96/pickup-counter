# Technical details

The full engineering reference for Pickup Counter. The [README](../README.md) has the overview; testing is covered in [TESTING.md](TESTING.md).

- [Architecture](#architecture)
- [API reference](#api-reference)
- [Payment webhook](#payment-webhook)
- [Database schema and stock model](#database-schema-and-stock-model)
- [Transactions and row locks](#transactions-and-row-locks)
- [Frontend](#frontend)
- [Development-only payment simulation](#development-only-payment-simulation)
- [Configuration and troubleshooting](#configuration-and-troubleshooting)
- [Decisions log](#decisions-log)
- [Security notes](#security-notes)

---

## Architecture

```
Browser ──► frontend (Vite :5173) ──/api proxy──► backend (Express :4000) ──► db (PostgreSQL :5432)
```

- The **browser** only calls `/api/...` on the page's own origin. The Vite dev server forwards those calls to `http://backend:4000` (`API_PROXY_TARGET`), so there is no CORS setup and the browser never needs Docker hostnames.
- Inside Docker, the **backend** connects to PostgreSQL at host `db`, the Compose service name.
- **PostgreSQL is the source of truth** for all inventory and order state.
- Every route is served both under `/api` (what the frontend calls) and at the root (`/health`, `/products`, …).
- Request flow: `route → middleware (requireJson / validate) → controller → service → PostgreSQL`. Errors go to `errorHandler`.

### Startup order and readiness

1. `db` starts. Its health check (`pg_isready`) passes once Postgres accepts connections.
2. `backend` waits for `db` to be **healthy**, applies pending migrations, inserts any missing development products (idempotent seed), then starts the API. Its health check calls `GET /health`, which runs `SELECT 1`.
3. `frontend` waits for `backend` to be **healthy**.

### Shutdown

`docker compose down` sends SIGTERM. Containers run with `init: true` so signals are forwarded correctly. The API then:
1. stops accepting new connections and lets in-flight requests finish (`server.close`)
2. closes the database pool
3. exits. A timer (`SHUTDOWN_TIMEOUT_MS`, default 10 s) forces exit if this hangs.

### Backend layout

```
backend/
  migrations/                Plain .sql files, applied in filename order
  scripts/send-webhook.ts    Signed webhook sender for local testing (npm run webhook:send)
  src/
    server.ts                Starts the HTTP server and expiry sweeper; graceful shutdown
    app.ts                   createApp(): middleware, routes, error handling (used by tests)
    config/env.ts            Zod-validated environment variables
    db/pool.ts               Shared pg connection pool
    db/migrate.ts            Migration runner
    db/seed.ts               Idempotent development seed (5 snacks) + safety guard
    db/cli/                  npm run migrate / npm run seed entry points
    db/transaction.ts        Shared rollback and PostgreSQL error-code helpers
    routes/                  URL -> controller wiring
    controllers/             HTTP layer: read request, call service, send response
    services/                Business logic and SQL
    schemas/                 Zod request schemas
    middleware/              validate (Zod), requireJson, verifyWebhookSignature,
                             parseRawJson, notFound, errorHandler
    payments/signature.ts    Webhook HMAC signing and verification
    jobs/expirySweeper.ts    In-process timer that persists 'expired' for overdue orders
    errors/AppError.ts       Errors that are safe to show to clients
  tests/                     Vitest + Supertest integration tests (see TESTING.md)
```

---

## API reference

**Error format.** Every error response has this shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Request validation failed.", "details": [...] } }
```

Unexpected errors are logged on the server and returned as a generic `500 INTERNAL_ERROR`. Stack traces and internal messages are never sent to clients.

### `GET /health`

Runs `SELECT 1`. Returns `200 {"status":"ok","database":"up",…}`, or `503` when the database is unreachable.

### `GET /products`

Lists the catalog, sorted by name. An empty catalog returns `{ "products": [] }` with status 200.

```json
{
  "products": [
    { "id": "a1b2c3d4-0005-4000-8000-000000000005", "name": "Chocolate Brownie", "pricePaise": 6000, "availableUnits": 12 }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `pricePaise` | Price in **integer paise** (6000 = Rs 60.00). The backend never converts to rupees. |
| `availableUnits` | Physical stock minus units held by unexpired unpaid orders and by paid, uncollected orders. Never negative. |

### `POST /orders`

Reserves stock for 120 seconds. Prices and availability always come from the database, never from the client.

```json
{ "items": [ { "productId": "a1b2c3d4-0001-4000-8000-000000000001", "quantity": 2 } ] }
```

Request rules (otherwise 400 `VALIDATION_ERROR`):
- `items` has 1–20 entries
- `productId` is a UUID
- `quantity` is an integer from 1 to 20
- each product appears **once**; duplicates are rejected, not merged
- unknown fields, such as a price, are rejected

**201 Created**, with a `Location: /api/orders/<id>` header:

```json
{
  "id": "e15fb5e3-…", "status": "pending", "totalPaise": 4000,
  "createdAt": "2026-10-23T07:50:10.221Z", "expiresAt": "2026-10-23T07:52:10.221Z",
  "expiresInSeconds": 119,
  "items": [ { "productId": "a1b2…0001", "name": "Samosa", "quantity": 2, "unitPricePaise": 2000, "lineTotalPaise": 4000 } ]
}
```

`expiresInSeconds` is calculated from database time when the response is built, rounded down. If the request had to wait for a lock, it is lower than 120.

| Status | `error.code` | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` / `INVALID_JSON` | Bad request body |
| 409 | `INSUFFICIENT_STOCK` | Any item lacks stock. `details` lists `{ productId, requested, available }`. Nothing is reserved. |
| 422 | `UNKNOWN_PRODUCT` | A product does not exist. `details.productIds` lists them. |
| 422 | `ORDER_TOTAL_TOO_LARGE` | The total would not fit in an `INTEGER` of paise |
| 503 | `RESERVATION_BUSY` | Product rows stayed locked for more than 5 s, or PostgreSQL aborted the transaction to break a deadlock. It was rolled back in full, so it is safe to retry. |

### `GET /orders/:id`

Returns the same shape as above, with the order's **current** status:
- An unpaid order past `expiresAt` is reported as `expired`, with `expiresInSeconds: 0`, even if nothing has stored that yet; the request also stores it.
- `expiresInSeconds` is `null` for `paid`, `needs_review` and `collected` orders.
- 404 `ORDER_NOT_FOUND` for an unknown id; 400 for a malformed id.

### `POST /orders/:id/pickup-claim`

Staff confirm that the customer has physically collected a **paid** order. This is the pickup route named in the project requirements, and the one the frontend uses. **Exactly one claim can succeed.**

| Case | Response |
| --- | --- |
| First claim of a `paid` order | **200**, the order with `status: "collected"`. Physical stock is deducted in the same transaction. |
| Competing (simultaneous) or later claim | **409** `ORDER_ALREADY_COLLECTED`, `details: { status: "collected" }`. No stock change. |
| `pending`, `expired` (stored, or unpaid past `expiresAt`), `needs_review` | **409** `ORDER_NOT_COLLECTABLE`, `details: { status }` |
| `paid`, but the shelf holds less than an item's quantity | **409** `INSUFFICIENT_PHYSICAL_STOCK`, `details: [{ productId, required, inStock }]`. Nothing changes. |
| Unknown id | **404** `ORDER_NOT_FOUND` |
| Missing or non-JSON `Content-Type` | **415** `UNSUPPORTED_MEDIA_TYPE`. Nothing changes. |
| Malformed id or any body field | **400** `VALIDATION_ERROR` |
| Rows locked > 5 s, or a deadlock | **503** `COLLECTION_BUSY`. Rolled back in full, so it is safe to retry. |

```bash
curl -X POST http://localhost:4000/orders/<id>/pickup-claim -H 'Content-Type: application/json' -d '{}'
```

### `POST /orders/:id/collect` (idempotent variant)

The same exactly-once collection and the same error cases as `pickup-claim`, kept for callers that prefer idempotent retries. The one difference: a repeat returns **200** with `"alreadyCollected": true` instead of 409. A first successful call returns `"alreadyCollected": false`.

### Why JSON is required on body-less POSTs

`pickup-claim`, `collect` and the dev payment simulator must be sent with `Content-Type: application/json`; the body may be empty or `{}`.
- A POST without a JSON content type is a CORS "simple request", which another website open in the same browser could fire blindly.
- Requiring `application/json` forces a CORS preflight instead, and this API grants none to other origins.
- `POST /orders` already requires a JSON body, and the signed webhook keeps its own raw-body contract.

---

## Payment webhook

### `POST /payments/webhook`

This simulates a payment provider reporting a payment.

```http
POST /payments/webhook
Content-Type: application/json
X-Signature: 3f1c…(64 lowercase hex chars)

{"eventId":"evt_123","orderId":"e15fb5e3-…","amountPaise":4000,"status":"captured"}
```

The `X-Signature` value may also be written as `sha256=3f1c…` (see [Signature verification](#signature-verification)).

| Field | Rules |
| --- | --- |
| `eventId` | The provider's unique event id. 1–200 characters: letters, digits and `_ . : -` |
| `orderId` | UUID of an existing order |
| `amountPaise` | Positive integer paise (`INTEGER` range) |
| `status` | `captured` or `failed`. Anything else gets 400. |

Unknown fields are rejected. The amount is **only compared** with the order's stored `total_paise`; it is never used as the order total.

### Signature verification

- **Header:** `X-Signature` is the **only** header read, where the digest is `HMAC-SHA256(PAYMENT_WEBHOOK_SECRET, raw request body bytes)`. Any other signature header (including the former `X-Pickup-Signature`) is ignored, so a request that carries only that one is rejected as `SIGNATURE_MISSING`.
- **Accepted value forms:** the original assignment's value format could not be checked, so both common forms are accepted:

  | Form | Example |
  | --- | --- |
  | Bare hex digest | `X-Signature: 3f1c…` (64 characters) |
  | `sha256=` + hex digest | `X-Signature: sha256=3f1c…` |
- **Exact bytes:** for the webhook path only, `app.ts` installs `express.raw()` **before** `express.json()`. The signature is computed over the exact bytes received, never re-serialised JSON. A test sends a body with unusual spacing to prove it.
- **Order of checks:** signature, then JSON parsing, then validation. Nothing about the payment is read before the signature passes.
- **Format first, strictly:** the value must be exactly 64 lowercase hex characters, optionally preceded by the lowercase prefix `sha256=`, and nothing else. Upper-case hex, an upper-case or repeated prefix, another scheme (`sha1=`), base64, and any other length are `SIGNATURE_MALFORMED`. The decoded length is checked before `crypto.timingSafeEqual` compares the bytes.
- **Rejections (401):** `SIGNATURE_MISSING`, `SIGNATURE_MALFORMED` or `SIGNATURE_INVALID`. A rejected request creates no event and changes no order.
- **Replays:** there is no timestamp in the signature. Replaying a captured request is harmless, because an `eventId` is never applied twice.

### Configuring the secret

`PAYMENT_WEBHOOK_SECRET` is **required**, must be at least 32 characters, and is validated in `src/config/env.ts`.
- **Local Docker:** Compose falls back to the placeholder `dev-only-insecure-webhook-secret-change-me`, the same as `.env.example`. Override it in `.env`.
- **Production:** the API refuses to start with any `dev-only-…` value when `NODE_ENV=production`. Use a long random value, for example `openssl rand -hex 32`.
- **Tests:** they use their own fixed key (`backend/vitest.config.ts`).
- **No leaks:** the secret is never logged or returned in responses.

### Sending a signed test webhook

```bash
# 1. Create an order and note its id and totalPaise
curl -s -X POST http://localhost:4000/orders -H 'Content-Type: application/json' \
  -d '{"items":[{"productId":"a1b2c3d4-0002-4000-8000-000000000002","quantity":2}]}'

# 2. Pay it (inside Docker the secret is already set)
docker compose exec backend npm run webhook:send -- --order <orderId> --amount <totalPaise>

# Send the same event twice to see idempotency (second reply has "duplicate":true)
docker compose exec backend npm run webhook:send -- --order <orderId> --amount <totalPaise> --repeat 2

# Or reuse a specific event id, choose a status, or target another URL
docker compose exec backend npm run webhook:send -- --order <orderId> --amount 999 \
  --event-id evt_manual_1 --status captured --url http://localhost:4000/payments/webhook

# Send the `sha256=<hex>` form instead of the bare hex digest (the default)
docker compose exec backend npm run webhook:send -- --order <orderId> --amount <totalPaise> --signature-format sha256

# From your machine instead of the container (Git Bash / Linux / macOS)
cd backend && PAYMENT_WEBHOOK_SECRET=dev-only-insecure-webhook-secret-change-me npm run webhook:send -- --order <orderId> --amount <totalPaise>
```

To sign and send a webhook by hand, sign the exact bytes you send:

```bash
BODY='{"eventId":"evt_manual_2","orderId":"<orderId>","amountPaise":<totalPaise>,"status":"captured"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$PAYMENT_WEBHOOK_SECRET" -r | cut -d' ' -f1)
curl -i -X POST http://localhost:4000/payments/webhook \
  -H 'Content-Type: application/json' -H "X-Signature: $SIG" --data-binary "$BODY"
# or: -H "X-Signature: sha256=$SIG"
```

The sender:
- sends the signature in `X-Signature`: the bare hex digest by default, or `sha256=<hex>` with `--signature-format sha256`
- generates `evt_<uuid>` unless `--event-id` is given
- signs exactly the bytes it sends
- prints each HTTP status and response body, never the secret
- exits with code 1 on any non-2xx response

### Processing and idempotency

All steps run in **one transaction**. Any failure rolls back both the event row and the order change. A test forces a database error mid-way, sees a 500 with no event stored, then confirms the retry succeeds.

1. **Lock the order row** (`FOR UPDATE`). An unknown order returns 404 and nothing is stored, because events must reference an existing order.
2. **Look up the `eventId`.**
   - Already processed: return 200 with `"duplicate": true` and the original outcome. Nothing is re-applied or re-evaluated.
   - Same `eventId` with a different order, amount or status: `409 EVENT_ID_CONFLICT`.
3. **If the order could become paid, lock its product rows** in id order, the same locks order creation takes. The deadline decision is then serialised with any order competing for those units.
4. **Decide using `clock_timestamp()`**, taken *after* the locks are held.
5. **Insert the event, update the order (guarded on the expected status), `COMMIT`.**

Idempotency is enforced by PostgreSQL, not by memory:
- **Same order:** simultaneous copies queue on the order lock. The first one applies the event, and the rest find it in step 2.
- **Different orders:** if the same `eventId` arrives for two orders at once, `UNIQUE (event_id)` rejects the second insert. The service rolls back, reads the stored event and returns 409.
- **State guard:** the status update re-checks the expected status, so a missing lock could never pay an order twice.

Every processed or duplicate event returns **200** (`{ eventId, orderId, outcome, orderStatus, duplicate }`), so the provider stops retrying. `PAYMENT_BUSY` (503) is returned if the order stays locked for more than 5 s, or on a deadlock. Nothing is recorded in either case, so a retry is safe.

### Outcomes (payment policy)

| Order state when the event is processed | Event | Outcome | Order becomes | Stock effect |
| --- | --- | --- | --- | --- |
| `pending`, before `expires_at`, amount = total | captured | `paid` | `paid` (`paid_at` = decision time) | Keeps its reservation. Physical stock unchanged until pickup. |
| `pending`, before `expires_at`, amount ≠ total | captured | `amount_mismatch` | `needs_review` | Reservation released (`needs_review` holds nothing). Nothing re-reserved or decremented. |
| `pending` past `expires_at`, or `expired` | captured | `late_payment` | `needs_review` (`expired_at` recorded) | Nothing re-reserved; units may already belong to another order |
| `paid` | captured | `already_paid` | unchanged | none |
| `needs_review` or `collected` | captured | `order_not_payable` | unchanged | none |
| any | failed | `payment_failed` | unchanged | none |

`payment_events.detail` stores the reason, for example `Paid 3999 paise; order total is 4000 paise.`

**No refunds are issued automatically.** There is no refund mechanism. `late_payment`, `amount_mismatch` and `already_paid` events are recorded for a person to resolve with the provider.

---

## Database schema and stock model

All rules are enforced by PostgreSQL itself, so invalid data is rejected whichever code path writes it.

**`products`** (migration `0002_create_products.sql`):

| Column | Type | Rules |
| --- | --- | --- |
| `id` | `UUID` | Primary key, `gen_random_uuid()` default |
| `name` | `TEXT` | Not blank, at most 120 chars, unique ignoring case |
| `price_paise` | `INTEGER` | `> 0` |
| `stock_quantity` | `INTEGER` | `>= 0`. Total physical units on hand |
| `created_at` / `updated_at` | `TIMESTAMPTZ` | `updated_at` maintained by a `BEFORE UPDATE` trigger |

**`orders` and `order_items`** (migration `0003_create_orders.sql`):

| Table | Column | Rules |
| --- | --- | --- |
| `orders` | `id UUID` | Primary key |
| | `status TEXT` | One of `pending`, `paid`, `expired`, `needs_review`, `collected` |
| | `total_paise INTEGER` | `> 0`. Fixed at creation from the price snapshots |
| | `expires_at TIMESTAMPTZ` | `now() + 120 s`, set by the database; must be after `created_at` |
| | `paid_at`, `expired_at`, `collected_at` | Must agree with `status` (CHECK constraints) |
| `order_items` | `order_id`, `product_id` | Foreign keys; one line per product per order (`UNIQUE`) |
| | `quantity INTEGER` | `> 0` |
| | `unit_price_paise INTEGER` | Price **snapshot** at order time |

**`payment_events`** (migration `0004_create_payment_events.sql`):

| Column | Rules |
| --- | --- |
| `event_id TEXT` | **`UNIQUE`**, not blank. This is the idempotency key. |
| `order_id UUID` | Foreign key to `orders`, indexed |
| `amount_paise INTEGER`, `status TEXT` | As reported (`> 0`; `captured` / `failed`) |
| `outcome TEXT`, `detail TEXT` | What the application did and why (`CHECK` on allowed outcomes) |
| `raw_payload TEXT` | The exact signed body, for audit |
| `received_at TIMESTAMPTZ` | Default `now()` |

### Status model

| Status | Holds stock? | Set by |
| --- | --- | --- |
| `pending` | Yes, while `expires_at > now()` | `POST /orders` |
| `paid` | Yes, until collected | A captured payment received in time with the exact amount (signed webhook or dev simulator) |
| `expired` | No | An unpaid order past `expires_at`, stored by the expiry sweep or by `GET /orders/:id` |
| `needs_review` | No; a person decides | A late or mismatched payment |
| `collected` | No; physical stock was deducted at pickup | `POST /orders/:id/pickup-claim` or `/collect`, only from `paid` |

### Physical stock vs. reservations

`products.stock_quantity` changes **only at pickup**. Creating or paying for an order does not touch it. Reservations are derived from orders in the `product_availability` view:

```
available_units = max(stock_quantity − Σ quantity of orders that are (pending AND expires_at > now()) OR paid, 0)
```

Both `GET /products` and order creation use this single definition. Pickup moves units from "reserved by a paid order" to "gone from the shelf" in one transaction, so availability does not change and nothing is subtracted twice. For an order of 3 from stock 10:
- pending or paid: `stock 10 · reserved 3 · available 7`
- collected: `stock 7 · reserved 0 · available 7`

### Expiry

- Availability never depends on a background job. An unpaid order stops reserving stock the instant `expires_at <= now()`, because every query checks the deadline.
- To keep the *stored* status accurate too, the API runs an in-process sweep every `ORDER_EXPIRY_SWEEP_INTERVAL_MS` (default 15 s), and `GET /orders/:id` persists `expired` when it reads an overdue order.
- Both use `WHERE status = 'pending' AND expires_at <= now()`, so they can never overwrite a paid order.

### Seeding

```bash
docker compose exec backend npm run seed
```

- Inserts 5 snacks with fixed UUIDs using `ON CONFLICT DO NOTHING`. Re-running inserts nothing and **never overwrites** existing rows.
- Refuses to run when `NODE_ENV=production`, or when the connected database is not `pickup_counter` or a name ending in `_dev` or `_test`.
- The Docker dev container runs it automatically on startup.

---

## Transactions and row locks

All three write paths run in a single `READ COMMITTED` transaction with `lock_timeout = 5s`. Product rows are always locked **in id order**, and paths that also lock an order lock it **first**. Lock acquisition therefore cannot form a cycle between these paths. If PostgreSQL still reports a deadlock (`40P01`) or a lock timeout (`55P03`), the transaction is rolled back and a 503 `*_BUSY` is returned; nothing is retried automatically.

### Order creation (no overselling)

1. `SELECT … FROM products WHERE id = ANY($1) ORDER BY id FOR UPDATE`: lock every requested product row.
2. A **new** statement recalculates availability from `product_availability`.
3. Insert the order, then its items, then `COMMIT`. Any error rolls back the whole transaction, so there are never partial orders or orphaned items.

Why two customers can never both get the last unit:
- Every transaction that adds reservations for a product holds that product's row lock until it commits, so the second customer waits at step 1.
- Under `READ COMMITTED`, each new statement sees freshly committed data, so the second transaction's step 2 sees the first order's reservation and returns 409.
- Expiry decisions use `now()`, the transaction's start time. A slightly older instant can only make a reservation look *still active*, never release stock early.

### Payment

See [Processing and idempotency](#processing-and-idempotency): order row lock, then the `eventId` lookup, then the product row locks, then the decision with `clock_timestamp()`, then a guarded update and commit.

### Pickup (`pickup-claim` / `collect`, exactly-once deduction)

All in `collectOrder` (`backend/src/services/orders.service.ts`):

1. Lock the order row (`FOR UPDATE`). Concurrent claims of the same order queue here, and so do payments for it.
2. Re-read the status under the lock.
   - `collected`: touch nothing; `pickup-claim` returns 409, `collect` returns 200 with `alreadyCollected: true`.
   - Anything other than `paid`: 409.
3. Lock the order's product rows in id order.
4. Check that physical stock covers every item.
5. `UPDATE products … SET stock_quantity = stock_quantity - quantity … WHERE stock_quantity >= quantity`, and check the affected row count equals the item count.
6. `UPDATE orders SET status = 'collected', collected_at = clock_timestamp() WHERE id = $1 AND status = 'paid'`, and check exactly 1 row changed.
7. `COMMIT`. Any failure rolls back the stock and the status together.

The test methodology and the mutation checks proving these layers are in [TESTING.md](TESTING.md#mutation-checks).

---

## Frontend

React + Vite + TypeScript, with no UI library. **The backend is the source of truth:** the page shows what the server returns and never decides prices, stock or status itself.

1. **Catalog** (`GET /products`): name, price formatted from integer paise using integer arithmetic only (for example `₹1,23,456.78`), and available units.
   - Quantity steppers are capped at `min(available, 20)`; sold-out products are disabled.
   - **The cart is in-page, not a separate page.** The per-product quantity controls hold the selection, and the order summary beneath them (item count, estimated total, and the reserve button) acts as the cart. The selection is submitted as a single order, and it is cleared once the order is created.
   - The estimated total is labelled as an estimate.
2. **Reserve** (`POST /orders`): sends only `{ items: [{ productId, quantity }] }`.
   - The button reads "Reserving…" and is disabled while the request runs, so double submits are ignored.
   - A `409 INSUFFICIENT_STOCK` names the product and how many are left; the catalog is re-fetched.
3. **Order panel** (`GET /orders/:id`): order ID, a status label with guidance, items, total and a countdown.
   - The order ID lives in the URL (`#/orders/<id>`), so a reload or shared link reopens it; nothing is stored in the browser.
   - Any order can be opened by ID.
4. **Countdown and polling.**
   - The countdown starts from the server's `expiresInSeconds`, measured from when the response arrived, so the device clock doesn't matter.
   - While `pending`, the order is re-checked every 5 s, never with two requests at once.
   - When the local countdown runs down to zero, the order is re-checked once. If the server still reports `pending` with 0 s left, the page waits for the next poll instead of re-fetching repeatedly.
   - Polling stops on any final status and when the view closes.
5. **Simulate payment** (pending orders, development only; see below). "Paid" appears only after `GET /orders/:id` confirms it.
6. **Staff: confirm pickup** (paid orders, `POST /orders/:id/pickup-claim`).
   - A success message appears only after the server confirms.
   - A `409 ORDER_ALREADY_COLLECTED` reads "already collected; no stock deducted again".
   - The UI states that there is **no staff login or PIN**.
7. After any action or status change (including expiry), the catalog is re-fetched. The browser never decrements stock itself.

---

## Development-only payment simulation

The real payment path is the HMAC-signed webhook. The browser cannot sign it, because it **never has** `PAYMENT_WEBHOOK_SECRET`: the variable is not `VITE_`-prefixed, not in the frontend container, and not in the bundle. So the "Simulate payment" button calls a separate **development-only** endpoint:

`POST /dev/orders/:id/simulate-payment` (also under `/api`)

- **It runs the normal payment service** (`processPaymentEvent`), exactly like a signed webhook. The order lock, the deadline check under the lock, `UNIQUE (event_id)` and the `needs_review` rules all apply: a late simulated payment becomes `needs_review`, and a second one is `already_paid`.
- **The server decides everything.** The amount is the order's stored `total_paise`, and the event ID is generated server-side (`devsim_<uuid>`). The request needs `Content-Type: application/json` (otherwise 415) with an empty body or `{}`; any field is rejected with 400.
- **It only exists when `DEV_PAYMENT_SIMULATOR=true`.** The flag defaults to `false`, and the API refuses to start with it set to `true` when `NODE_ENV=production`. Compose enables it for local development, and publishes the API on 127.0.0.1 only. When it is off, the route returns 404 and the UI points to the signed webhook sender.
- **It moves no real money** and does not exercise signature verification; the webhook tests cover that.

Never enable it on a shared or public server.

---

## Configuration and troubleshooting

### Running the apps outside Docker (optional)

```bash
docker compose up -d db

cd backend
export DATABASE_URL=postgres://pickup:pickup_dev_password@localhost:5433/pickup_counter
npm install && npm run migrate && npm run dev

cd ../frontend
npm install && npm run dev        # proxies /api to http://localhost:4000 by default
```

### Scripts

| Backend | Purpose |
| --- | --- |
| `npm run dev` | API with live reload (tsx watch) |
| `npm run build` / `npm start` | Compile to `dist/` / run the compiled API |
| `npm run migrate` / `npm run seed` | Apply pending migrations / insert development data |
| `npm run typecheck` / `npm run lint` | `tsc --noEmit` / ESLint (type-aware) |
| `npm test` | Integration tests (needs `TEST_DATABASE_URL`; see [TESTING.md](TESTING.md)) |
| `npm run webhook:send -- …` | Send a signed payment webhook (needs `PAYMENT_WEBHOOK_SECRET`) |

| Frontend | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server on :5173 |
| `npm run build` / `npm run preview` | Typecheck + production build / preview the build |
| `npm run typecheck` / `npm run lint` | `tsc --noEmit` / ESLint |
| `npm test` | Component tests (Vitest + jsdom + Testing Library) |

### Port 5433 conflicts on the host

Inside Docker the backend always uses `db:5432`; the host port only matters for publishing. Ports are published on `127.0.0.1`, so if another program already listens on 5433, `docker compose up` fails to start the database with an error like:

```
ports are not available: exposing port TCP 127.0.0.1:5433 … bind: An attempt was made to access a socket in a way forbidden by its access permissions
```

To fix it, set `POSTGRES_HOST_PORT` to a free port (for example `5434`), either in a local, git-ignored `.env` or on the command line (`POSTGRES_HOST_PORT=5434 docker compose up -d`). Use the same port in host-side `DATABASE_URL` / `TEST_DATABASE_URL`, and export `POSTGRES_HOST_PORT` for host-side tests so the test-database guard accepts it.

### Changing the database password

PostgreSQL reads `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB` **only when the data volume is first created**. Changing them later, for example in `.env`, does **not** change the existing database. The backend then gets `password authentication failed for user "pickup"` (`28P01`) and stays unhealthy.

The local default is `pickup_dev_password` in both the Compose defaults and `.env.example`. If login fails, recover without deleting data. Choose **one**:
- **Go back to the password the volume was created with:** remove or restore `POSTGRES_PASSWORD` in `.env`.
- **Change the stored password to match:** connections from inside the `db` container use local trust auth, so no old password is needed.
  ```bash
  docker compose exec db psql -U pickup -d postgres -c "ALTER ROLE pickup PASSWORD 'your_new_password'"
  docker compose up -d backend
  ```

`docker compose down -v` also "fixes" it, but it **deletes all data**. Use it only when you want an empty database.

---

## Decisions log

| # | Decision | Why |
| - | -------- | --- |
| 1 | Money stored as integer **paise** (`INTEGER`), never floats | Floating-point cannot represent 0.1 exactly; integers are exact. |
| 2 | PostgreSQL is the source of truth; concurrency handled with transactions + row locks / conditional `UPDATE`s | Several customers can buy the last item at once; only the DB can arbitrate safely. |
| 3 | Express 5 | Errors thrown in async handlers reach the error handler automatically. |
| 4 | Small in-house SQL migration runner (advisory lock + one transaction per file + `schema_migrations` table) | Zero extra dependencies; plain SQL is easy to review. |
| 5 | Zod for env and request validation | One library, TypeScript types inferred from schemas. |
| 6 | Frontend calls same-origin `/api`, proxied by Vite | No CORS; `API_PROXY_TARGET` has no `VITE_` prefix, so it is never bundled into browser code. |
| 7 | `/health` checks the database (`SELECT 1`), returning 200 or 503 | A container that cannot reach its DB is not healthy. |
| 8 | Postgres published on host port **5433** | Avoids clashing with a locally installed PostgreSQL on 5432. |
| 9 | Compose has local-only fallback credentials | `docker compose up --build` works on a fresh clone; real secrets never live in the repo. |
| 10 | Integration tests run against a dedicated `_test` database, files run sequentially | Real DB behaviour (locks, constraints) without risking dev data. |
| 11 | `price_paise` and `stock_quantity` are `INTEGER`, not `BIGINT` | node-postgres returns `BIGINT` as a string; `INTEGER` arrives as a JS number and holds up to about Rs 2.1 crore. |
| 12 | Data rules live in DB `CHECK` constraints and a unique index on `lower(name)` | The database is the last line of defence, whatever code writes to it. |
| 13 | `availableUnits` computed in SQL by the `product_availability` view | One definition of "stock minus active reservations", used by the catalog and order creation. |
| 14 | Seed uses fixed UUIDs + `ON CONFLICT DO NOTHING` and a database-name guard | Repeatable, never clobbers live stock, cannot seed an arbitrary database. |
| 15 | `GET /products` returns `{ "products": [...] }`, not a bare array | Room to add fields (e.g. pagination) later without breaking clients. |
| 16 | Test DB guarded by config allow-list + database-comment marker + verified connection + session advisory lock held for the whole run | Defence in depth: a wrong URL, wrong server, unmarked DB or overlapping run all fail before any destructive SQL. |
| 17 | One local default password (`pickup_dev_password`) in Compose and `.env.example`, checked by `tests/config.test.ts` | Copying `.env.example` must never lock the backend out of an existing volume. |
| 18 | Reservations derived from orders (view `product_availability`); `stock_quantity` changes only at pickup | No counter to drift: an expired order frees stock instantly. |
| 19 | `SELECT … FOR UPDATE` on product rows in id order, then recheck availability in a new statement | Serialises competing orders per product; consistent lock order prevents deadlocks. |
| 20 | Expiry = `expires_at <= now()` in every query, plus an in-process sweep and on-read reconciliation that only touch `pending` | Correct without the sweep; the sweep only tidies stored status and can never overwrite `paid`. |
| 21 | Duplicate product IDs in one order are rejected (400), not merged | The client sees exactly what was ordered. |
| 22 | Limits: ≤ 20 line items, quantity 1–20, total must fit `INTEGER` paise | Bounds work per request and guarantees safe integer arithmetic. |
| 23 | `needs_review` holds no stock | A late payment must not silently re-reserve units already sold to someone else; staff resolve it. |
| 24 | Webhook signature = HMAC-SHA256 over the raw body, in the `X-Signature` header, raw parser only on the webhook path | Verifies the exact bytes; JSON parsing happens only after authentication. |
| 25 | Idempotency via `UNIQUE (event_id)` in the same transaction as the order update | Durable and race-safe without Redis or memory state; nothing half-applied. |
| 26 | Payment locks the order row **and** its product rows, then decides with `clock_timestamp()` | Serialises the deadline decision with competing order creation, so a boundary-time payment can never revive units already re-sold. |
| 27 | Unknown-order events return 404 and are not stored | `payment_events.order_id` is a foreign key; there is no order to attach them to. |
| 28 | `amount_mismatch` / `late_payment` → `needs_review`; no automatic refund | Money problems need a person; the system never claims a refund it cannot perform. |
| 29 | Pickup locks the order row, re-checks status, locks products in id order, guarded deduction + guarded status update, one transaction | Exactly-once physical stock deduction under concurrency, with the same lock order as creation and payment. |
| 30 | `/collect` repeat returns 200 with `alreadyCollected: true` | Idempotent for retries; mirrors the webhook's `duplicate: true`. |
| 31 | Shelf shortage at pickup → 409 `INSUFFICIENT_PHYSICAL_STOCK`, order stays `paid` | A write-off after payment must not silently hand over a partial order. |
| 32 | No new migration for pickup | `collected_at` and its `CHECK` constraints already existed (0003); old migrations are never edited. |
| 33 | Browser "pay" goes through a dev-only server endpoint that calls the normal payment service | Client-side signing would leak the secret; a public mark-as-paid endpoint would bypass the payment rules. |
| 34 | Order ID kept in the URL hash, not localStorage | Survives reloads and can be shared; stores no data in the browser. |
| 35 | Countdown anchored to the server's `expiresInSeconds`; it re-checks once when it runs down, then relies on polling | Device clocks are never trusted; no request burst at the expiry instant. |
| 36 | No UI library or state manager; plain React state and hooks | Two panels and a handful of endpoints do not need extra dependencies. |
| 37 | `POST /orders/:id/pickup-claim` returns 409 to the competing claim; `/collect` kept as the idempotent variant | Matches the requirement as given without breaking the earlier route; both share one exactly-once service. |
| 38 | Body-less state-changing POSTs require `Content-Type: application/json`; published ports bound to 127.0.0.1 | Blocks blind cross-site requests and keeps local services (including the dev simulator) off the network. |
| 39 | `X-Signature` is the only signature header; its value may be the bare 64-hex digest or `sha256=` + 64-hex | The original assignment's value format could not be checked, so both strict forms are accepted. Each is length-checked and compared with `timingSafeEqual`, so accepting both adds no weakness. The earlier `X-Pickup-Signature` header was this project's own invention and is no longer read. |

---

## Security notes

- `.env` is git-ignored. `.env.example` contains documented local placeholders only.
- All SQL uses parameter placeholders (`$1`, `$2`, …). User input is never concatenated into SQL.
- Env validation errors print variable names only, never values.
- `x-powered-by` is disabled; JSON bodies are limited to 100 kB, webhook bodies to 64 kB.
- Published ports bind to `127.0.0.1` only. Body-less state-changing POSTs require a JSON content type (see [above](#why-json-is-required-on-body-less-posts)).
- `pickup-claim` and `/collect` have **no staff authentication**, because the requirements given for this project define none. Order IDs are random UUIDs.
- The final engineering audit, with its findings and their status, is in [FINAL_AUDIT.md](FINAL_AUDIT.md).

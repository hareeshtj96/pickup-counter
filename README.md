# Pickup Counter

A full-stack TypeScript application for ordering items for counter pickup.

| Layer    | Technology                                     |
| -------- | ---------------------------------------------- |
| Backend  | Node.js 22, Express 5, TypeScript (strict), Zod |
| Database | PostgreSQL 16 via `pg` (parameterized SQL only) |
| Frontend | React 19, Vite 6, TypeScript (strict)          |
| Tests    | Vitest + Supertest against a real PostgreSQL DB |
| Runtime  | Docker + Docker Compose                        |

**Status:** Phases 1–6 are complete:
- foundation
- product catalog
- orders with 120-second stock reservations
- signed, idempotent payment webhook
- pickup collection with exactly-once stock deduction
- the React frontend for the whole flow

---

## Quick start

**Prerequisites**
- **Docker Desktop**, running. This is all you need for the standard flow below: the backend tests and the webhook sender run inside the backend container.
- **Node.js ≥ 22** and npm, *only* for commands run directly on your machine, such as the frontend tests (`cd frontend && npm test`), typecheck/lint/build, or the webhook sender run from the host. Install the dependencies first with `npm ci` in `backend/` and/or `frontend/`.

```bash
docker compose up --build
```

| Service  | URL                                  |
| -------- | ------------------------------------ |
| Frontend | http://localhost:5173                |
| API      | http://localhost:4000/health         |
| Postgres | `localhost:5433` (user `pickup`, db `pickup_counter`) |

All three ports are published on **127.0.0.1 only**: they are reachable from this machine but not from the rest of the network. Containers still reach each other by service name (`db:5432`, `backend:4000`).

No `.env` is required. Compose falls back to **local-only** defaults. To change ports or credentials:

```bash
cp .env.example .env   # then edit
```

### Verify

```bash
docker compose ps                              # db, backend, frontend all "healthy"
curl -i http://localhost:4000/health           # 200 {"status":"ok","database":"up",...}
curl -i http://localhost:4000/api/health       # 200 (same, under /api)
curl -i http://localhost:5173/api/health       # 200, via the Vite proxy (frontend -> backend)
curl -i http://localhost:4000/products         # 200 {"products":[...5 seeded snacks...]}
curl -i -X POST http://localhost:4000/orders -H 'Content-Type: application/json' \
  -d '{"items":[{"productId":"a1b2c3d4-0001-4000-8000-000000000001","quantity":2}]}'   # 201, reserves 2 Samosas
curl -i http://localhost:4000/orders/<id>      # 200, status + expiresInSeconds
docker compose exec backend npm run webhook:send -- --order <id> --amount <totalPaise>   # signed payment -> paid
curl -i -X POST http://localhost:4000/orders/<id>/pickup-claim \
  -H 'Content-Type: application/json' -d '{}'   # 200, collected; physical stock deducted once (a second claim -> 409)
docker compose exec backend npm test           # integration tests on pickup_counter_test
```

Open http://localhost:5173. You should see the snack catalog. See [Frontend](#frontend) for the full walkthrough.

## Frontend

React + Vite + TypeScript, with no UI library. The browser only calls `/api/...`, and the Vite dev server proxies those calls to the backend (`API_PROXY_TARGET`). **The backend is the source of truth for everything.** The page shows what the server returns and never decides prices, stock or status itself.

**Flow at http://localhost:5173:**
1. **Catalog** (`GET /products`): each product shows its name, its price formatted from integer paise (for example `₹1,23,456.78`, using integer arithmetic only), and its available units.
   - Quantity steppers are capped at `min(available, 20)`. Sold-out products are disabled.
   - The estimated total is labelled as an estimate; the server sets the real one.
2. **Reserve** (`POST /orders`): sends only `{ items: [{ productId, quantity }] }`.
   - The button is disabled and reads "Reserving…" while the request is in flight, so double submits are ignored.
   - A `409 INSUFFICIENT_STOCK` names the product and how many are left, and the catalog is re-fetched.
   - Validation, busy (503) and network errors are explained in plain language.
3. **Order panel** (`GET /orders/:id`): shows the order ID, a status label with next-step guidance, the items, the total, and a countdown.
   - The countdown starts from the server's `expiresInSeconds`, so the device clock doesn't matter.
   - The order ID lives in the URL (`#/orders/<id>`), so a reload or a shared link reopens it. Nothing is stored in the browser.
   - You can also open any order by ID.
4. **Status polling:** only while the order is `pending`, every 5 s, never two requests at once. Polling stops on `paid`, `expired`, `needs_review` or `collected`, and when the view closes. When the local countdown runs down to zero, the order is re-checked with the server once. If the server still reports `pending` with 0 seconds left (its last instant before expiry), the page waits for the next 5 s poll instead of re-fetching repeatedly.
5. **Simulate payment** (pending orders only, development only): see below. The status changes to "Paid" only after `GET /orders/:id` confirms it.
6. **Staff: confirm pickup** (paid orders only; `POST /orders/:id/pickup-claim`):
   - A success message appears only after the server confirms.
   - A claim that loses to another (`409 ORDER_ALREADY_COLLECTED`) reads "already collected; no stock deducted again".
   - `ORDER_NOT_COLLECTABLE`, `INSUFFICIENT_PHYSICAL_STOCK` and `COLLECTION_BUSY` show the server's reason.
   - The UI states plainly that there is **no staff login or PIN**.
7. After creating, paying, collecting, or any change of status (including expiry), the catalog is re-fetched. The browser never decrements stock itself.

### Development-only payment simulation

The real payment path is the HMAC-signed webhook. The browser cannot sign it, because it **never has** `PAYMENT_WEBHOOK_SECRET`: that variable is not `VITE_`-prefixed, is not in the frontend container, and is not in the bundle (verified). So the "Simulate payment" button calls a separate **development-only** endpoint:

`POST /dev/orders/:id/simulate-payment` (also under `/api`)

- **It runs the normal payment service** (`processPaymentEvent`), exactly like a signed webhook. That means the order lock, the deadline check made under the lock, `UNIQUE (event_id)` and the `needs_review` rules all still apply.
  - A late simulated payment becomes `needs_review`.
  - A second one is `already_paid`.
- **The server decides everything:** the amount is the order's stored `total_paise` and the event ID is generated server-side (`devsim_<uuid>`). The request must be sent as `Content-Type: application/json` (otherwise **415** `UNSUPPORTED_MEDIA_TYPE`), with an empty body or `{}`. Any fields sent are rejected with 400.
- **Only reachable from this machine:** Compose publishes the API on 127.0.0.1 only.
- **It only exists when `DEV_PAYMENT_SIMULATOR=true`.** That flag defaults to `false`, and the API refuses to start with it set to `true` when `NODE_ENV=production`. Docker Compose sets it to `true` for local development only. When it is off, the route returns 404 and the UI points you to the signed webhook sender instead.
- **It moves no real money** and does not test signature verification; the webhook tests cover that.

Anyone who can reach a development API can call this endpoint for any order ID. Never enable it on a shared or public server.

### Stop

```bash
docker compose down      # stop containers, keep database data
docker compose down -v   # also delete the database volume (fresh start)
```

---

## Architecture

```
Browser ──► frontend (Vite :5173) ──/api proxy──► backend (Express :4000) ──► db (PostgreSQL :5432)
```

- The **browser** only calls `/api/...` on the same origin as the page. The Vite dev server forwards those calls to `http://backend:4000`, so there is no CORS setup and the browser never needs Docker hostnames.
- Inside Docker, the **backend** connects to PostgreSQL at host `db`, the Compose service name. It never uses `localhost`, because inside a container `localhost` means the container itself.
- **PostgreSQL is the source of truth** for all inventory and order state. The frontend never decides stock availability.

### Startup order and readiness

1. `db` starts. Its health check (`pg_isready`) passes once Postgres accepts connections.
2. `backend` waits for `db` to be **healthy**, applies pending migrations, inserts any missing development products (idempotent seed), then starts the API. Its health check calls `GET /health`, which runs `SELECT 1`.
3. `frontend` waits for `backend` to be **healthy**.

### Shutdown

`docker compose down` sends SIGTERM. Containers run with `init: true` so signals are forwarded correctly. The API then:
1. stops accepting new connections and lets in-flight requests finish (`server.close`),
2. closes the database pool,
3. exits. A timer (`SHUTDOWN_TIMEOUT_MS`, default 10 s) forces exit if this hangs.

### Backend layout

```
backend/
  migrations/              Plain .sql files, applied in filename order
  src/
    server.ts              Starts the HTTP server, graceful shutdown
    app.ts                 createApp(): middleware, routes, error handling (used by tests)
    config/env.ts          Zod-validated environment variables
    db/pool.ts             Shared pg connection pool
    db/migrate.ts          Migration runner
    db/seed.ts             Idempotent development seed (5 snacks) + safety guard
    db/cli/                `npm run migrate` / `npm run seed` entry points
    routes/                URL -> controller wiring
    controllers/           HTTP layer: read request, call service, send response
    services/              Business logic and SQL
    schemas/               Zod request schemas
    jobs/expirySweeper.ts  In-process timer that persists 'expired' for overdue orders
    payments/signature.ts  Webhook HMAC signing and verification
    db/transaction.ts      Shared rollback / PostgreSQL error-code helpers
  scripts/send-webhook.ts  Signed webhook sender for local testing (`npm run webhook:send`)
    middleware/            validate (Zod), notFound, errorHandler
    errors/AppError.ts     Errors that are safe to show to clients
  tests/                   Vitest + Supertest integration tests
```

Request flow: `route → validate middleware → controller → service → PostgreSQL`. Errors go to `errorHandler`.

Every route is served both under `/api` (what the frontend calls) and at the root (`/health`, `/products`).

---

## API

### `GET /products`

Lists the catalog, sorted by name.

```json
{
  "products": [
    { "id": "a1b2c3d4-0005-4000-8000-000000000005", "name": "Chocolate Brownie", "pricePaise": 6000, "availableUnits": 12 }
  ]
}
```

| Field            | Meaning |
| ---------------- | ------- |
| `id`             | Product UUID |
| `name`           | Display name |
| `pricePaise`     | Price in **integer paise** (6000 = Rs 60.00). The frontend formats it for display; the backend never converts to rupees. |
| `availableUnits` | Units a customer can still buy: physical stock minus units held by unexpired unpaid orders and by paid, uncollected orders. Never negative. |

An empty catalog returns `{ "products": [] }` with status 200.

### `POST /orders`

Reserves stock for 120 seconds. Prices and availability always come from the database, never from the client.

```json
{ "items": [ { "productId": "a1b2c3d4-0001-4000-8000-000000000001", "quantity": 2 } ] }
```

Request rules (400 `VALIDATION_ERROR` otherwise):
- `items` must have 1–20 entries.
- `productId` must be a UUID.
- `quantity` must be an integer from 1 to 20.
- Each product may appear **once**. Duplicates are rejected, not merged.
- Unknown fields such as a price are rejected.

**201 Created** (with a `Location: /api/orders/<id>` header):

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
| ------ | ------------ | ---- |
| 400 | `VALIDATION_ERROR` / `INVALID_JSON` | Bad request body |
| 409 | `INSUFFICIENT_STOCK` | Any item lacks stock. `details` lists `{ productId, requested, available }`. Nothing is reserved. |
| 422 | `UNKNOWN_PRODUCT` | A product does not exist. `details.productIds` lists them. |
| 422 | `ORDER_TOTAL_TOO_LARGE` | The total would not fit in an `INTEGER` of paise |
| 503 | `RESERVATION_BUSY` | The product rows stayed locked for more than 5 s, or PostgreSQL aborted the transaction to break a deadlock. It was rolled back in full, so it is safe to retry; database details are never returned. |

### `GET /orders/:id`

Returns the same shape as above, with the order's **current** status:

- An unpaid order past `expiresAt` is reported as `expired`, with `expiresInSeconds: 0`, even if nothing has stored that yet. The request also stores it.
- `expiresInSeconds` is `null` for `paid`, `needs_review` and `collected` orders, because the deadline no longer applies to them.
- 404 `ORDER_NOT_FOUND` for an unknown id; 400 for a malformed id.

### `POST /orders/:id/pickup-claim`

Staff confirm that the customer has physically collected a **paid** order. This is the pickup route named in the brief, and the one the frontend uses. It is also served at `/api/orders/:id/pickup-claim`. **Exactly one claim can succeed:**

| Case | Response |
| --- | --- |
| First claim of a `paid` order | **200**, the order with `status: "collected"`. Physical stock is deducted in the same transaction. |
| Competing claim (simultaneous) or any later claim | **409** `ORDER_ALREADY_COLLECTED`, with `details: { status: "collected" }`. No stock change. |
| `pending`, `expired`, `needs_review` | **409** `ORDER_NOT_COLLECTABLE` |
| Shelf shortage, unknown id, bad id/body, missing JSON `Content-Type`, rows locked | Same as `/collect` below: 409 `INSUFFICIENT_PHYSICAL_STOCK`, 404, 400, 415, 503 `COLLECTION_BUSY` |

```bash
curl -X POST http://localhost:4000/orders/<id>/pickup-claim -H 'Content-Type: application/json' -d '{}'
```

When two claims arrive at once, both queue on the order's row lock. The first one deducts the stock and sets the order to `collected`. The second then reads `collected` under the lock and gets 409 (test: "two simultaneous pickup claims: exactly one succeeds, the other gets 409").

### `POST /orders/:id/collect` (idempotent variant)

The same exactly-once collection, kept from Phase 5 for callers that prefer idempotent retries: a repeat returns **200** with `"alreadyCollected": true` instead of 409. It is also served at `/api/orders/:id/collect`. The request must declare `Content-Type: application/json`; the body can be empty or `{}`, and any body fields are rejected with 400. There is no PIN or staff authentication, because the requirements define none.

```bash
curl -X POST http://localhost:4000/orders/<id>/collect -H 'Content-Type: application/json' -d '{}'
```

**Why JSON is required although there is no body:**
- A POST without a JSON content type is a CORS "simple request", which another website open in the same browser could fire blindly.
- Requiring `application/json` forces a CORS preflight instead, and this API grants none to other origins.
- `pickup-claim` and the dev payment simulator have the same rule.
- `POST /orders` already requires a JSON body, and the signed webhook keeps its own raw-body contract.

| Order state | Response |
| --- | --- |
| `paid` | **200**, the order (same shape as `GET /orders/:id`) with `status: "collected"` and `"alreadyCollected": false`. Each item's quantity is deducted from physical stock. |
| `collected` | **200**, the order with `"alreadyCollected": true`. Nothing changes, so retries and double-clicks are harmless. |
| `pending`, `expired` (stored, or unpaid past `expiresAt`), `needs_review` | **409** `ORDER_NOT_COLLECTABLE`, with `details: { status }` |
| `paid`, but the shelf holds less than an item's quantity | **409** `INSUFFICIENT_PHYSICAL_STOCK`, with `details: [{ productId, required, inStock }]`. Nothing changes. |
| unknown id | **404** `ORDER_NOT_FOUND` |
| missing or non-JSON `Content-Type` | **415** `UNSUPPORTED_MEDIA_TYPE`. Nothing changes. |
| malformed id or body field | **400** `VALIDATION_ERROR` |
| rows locked > 5 s, or a database deadlock | **503** `COLLECTION_BUSY`. The transaction was rolled back in full, so it is safe to retry. |

**How stock is deducted exactly once.** Everything runs in one transaction (`collectOrder` in `orders.service.ts`):

1. Lock the order row (`FOR UPDATE`). Concurrent collections of the same order queue here, and so do payments for it.
2. Re-read the status under the lock. If it is `collected`, acknowledge without touching stock. If it is anything other than `paid`, return 409.
3. Lock the order's product rows in **id order**. Order creation and payment use the same order, so lock acquisition can never form a deadlock cycle.
4. Check that physical stock covers every item.
5. `UPDATE products … SET stock_quantity = stock_quantity - quantity … WHERE stock_quantity >= quantity`, then check that the affected row count equals the item count.
6. `UPDATE orders SET status = 'collected', collected_at = clock_timestamp() WHERE id = $1 AND status = 'paid'`, and check that exactly 1 row changed.
7. `COMMIT`. Any failure rolls back the stock and the status together.

Tests prove the layers:
- **Lock and guard together:** two simultaneous collections of one order give one `false` and one `true`, with stock deducted once.
- **Removing the lock:** the status guard still prevents a double deduction, and the loser gets a 500.
- **Removing both:** stock was deducted **twice** in 9 out of 10 races.

No migration was needed: `orders.collected_at` and its `CHECK` constraints already existed from migration 0003.

## Payment webhook

### `POST /payments/webhook`

This simulates a payment provider reporting a payment. It is also served at `/api/payments/webhook`.

```http
POST /payments/webhook
Content-Type: application/json
X-Pickup-Signature: sha256=3f1c…(64 lowercase hex chars)

{"eventId":"evt_123","orderId":"e15fb5e3-…","amountPaise":4000,"status":"captured"}
```

| Field | Rules |
| ----- | ----- |
| `eventId` | The provider's unique event id. 1–200 characters: letters, digits and `_ . : -` |
| `orderId` | UUID of an existing order |
| `amountPaise` | Positive integer paise (`INTEGER` range) |
| `status` | `captured` or `failed`. Anything else gets 400. |

Unknown fields are rejected. The amount is **only compared** with the order's stored `total_paise`; it is never used as the order total.

### Signature verification

- **Header:** `X-Pickup-Signature: sha256=<hex>`, where `hex = HMAC-SHA256(PAYMENT_WEBHOOK_SECRET, raw request body bytes)`.
- **Exact bytes:** for this path only, `app.ts` installs `express.raw()` **before** `express.json()`. The signature is computed over the exact bytes received, never over re-serialised JSON. A test sends a body with unusual spacing to prove it.
- **Order of checks:** signature first, then JSON parsing, then validation. Nothing about the payment is read before the signature passes.
- **Format first:** the header must match `sha256=` followed by exactly 64 lowercase hex characters, and the decoded length is checked, before `crypto.timingSafeEqual` compares the bytes.
- **Rejections (401):** `SIGNATURE_MISSING`, `SIGNATURE_MALFORMED` or `SIGNATURE_INVALID`. A rejected request creates no event and changes no order.
- **Replays:** there is no timestamp in the signature. Replaying a captured request is harmless, because the same `eventId` is never applied twice.

### Configuring the secret

`PAYMENT_WEBHOOK_SECRET` is **required**, must be at least 32 characters, and is validated in `src/config/env.ts`.

- **Local Docker:** Compose falls back to the placeholder `dev-only-insecure-webhook-secret-change-me`, the same value as in `.env.example`. To override it, set it in `.env`.
- **Production:** the API refuses to start with any `dev-only-…` value when `NODE_ENV=production`. Use a long random value, for example `openssl rand -hex 32`.
- **Tests:** they use their own fixed key (`vitest.config.ts`).
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

# From your machine instead of the container (Git Bash / Linux / macOS)
cd backend && PAYMENT_WEBHOOK_SECRET=dev-only-insecure-webhook-secret-change-me npm run webhook:send -- --order <orderId> --amount <totalPaise>
```

The sender:
- generates `evt_<uuid>` unless `--event-id` is given
- signs exactly the bytes it sends
- prints each HTTP status and response body, never the secret
- exits with code 1 on any non-2xx response

### Processing and idempotency

All steps run in **one transaction**. Any failure rolls back both the event row and the order change. A test forces a database error mid-way, sees `500` with no event stored, and then confirms the retry succeeds.

1. **Lock the order row** (`FOR UPDATE`). An unknown order returns 404, and nothing is stored, because events must reference an existing order.
2. **Look up the `eventId`.**
   - If it was already processed, return 200 with `"duplicate": true` and the original outcome. Nothing is re-applied. The event is not even re-evaluated, so a duplicate of a paid event still reports `paid` after the deadline.
   - If the `eventId` was used with a different order, amount or status: `409 EVENT_ID_CONFLICT`.
3. **If the order could become paid, lock its product rows** in id order, the same locks order creation takes. The deadline decision is then serialised with any order competing for those units. Without this, a payment judged "in time" at 119.99 s could commit just after a new order had taken the units at 120.00 s.
4. **Decide using `clock_timestamp()`**, which is taken *after* the locks are held. The order lock alone is not enough, because the expiry check must also be serialised with competing order creation.
5. **Insert the event, update the order, `COMMIT`.**

Idempotency is enforced by PostgreSQL, not by memory:
- **Same order:** simultaneous copies of an event queue on the order lock. The first one applies the event, and the rest find it in step 2.
- **Different orders:** if the same `eventId` arrives for two different orders at the same moment, `UNIQUE (event_id)` rejects the second insert. The service rolls back, reads the stored event and returns `409`.
- **State guard:** the status update also re-checks the expected current status, so a missing lock could never pay an order twice. A test that removed the order lock got `500`s, not double payments.

Every processed or duplicate event returns **200** (`{ eventId, orderId, outcome, orderStatus, duplicate }`), so the provider stops retrying. `PAYMENT_BUSY` (503) is returned if the order stays locked for more than 5 s, or if PostgreSQL aborts the transaction to break a deadlock. Nothing is recorded in either case, so the provider's retry is safe.

### Outcomes

| Order state when the event is processed | Event | Outcome | Order becomes | Stock effect |
| --- | --- | --- | --- | --- |
| `pending`, before `expires_at`, amount = total | captured | `paid` | `paid` (`paid_at` = decision time) | Keeps its reservation. Physical stock unchanged until pickup. |
| `pending`, before `expires_at`, amount ≠ total | captured | `amount_mismatch` | `needs_review` | Reservation released (`needs_review` holds nothing). Nothing re-reserved or decremented. |
| `pending` past `expires_at`, or `expired` | captured | `late_payment` | `needs_review` (`expired_at` recorded) | Nothing re-reserved; units may already belong to another order |
| `paid` | captured | `already_paid` | unchanged | none |
| `needs_review` or `collected` | captured | `order_not_payable` | unchanged | none |
| any | failed | `payment_failed` | unchanged | none |

`payment_events.detail` stores the reason, for example `Paid 3999 paise; order total is 4000 paise.`

**No refunds are issued.** There is no refund mechanism. `late_payment`, `amount_mismatch` and `already_paid` events are recorded for a person to resolve with the provider.

## Database schema

`products` (migration `0002_create_products.sql`):

| Column           | Type          | Rules |
| ---------------- | ------------- | ----- |
| `id`             | `UUID`        | Primary key, `gen_random_uuid()` default |
| `name`           | `TEXT`        | Not blank, at most 120 chars, unique ignoring case |
| `price_paise`    | `INTEGER`     | `> 0` |
| `stock_quantity` | `INTEGER`     | `>= 0`. Total physical units on hand |
| `created_at`     | `TIMESTAMPTZ` | Default `now()` |
| `updated_at`     | `TIMESTAMPTZ` | Maintained by a `BEFORE UPDATE` trigger |

The rules are enforced by PostgreSQL itself, so invalid data is rejected no matter which code path writes it.

`orders` and `order_items` (migration `0003_create_orders.sql`):

| Table | Column | Rules |
| ----- | ------ | ----- |
| `orders` | `id UUID` | Primary key |
| | `status TEXT` | One of `pending`, `paid`, `expired`, `needs_review`, `collected` |
| | `total_paise INTEGER` | `> 0`. Fixed at creation from the price snapshots |
| | `created_at`, `updated_at` | `updated_at` is maintained by the trigger |
| | `expires_at TIMESTAMPTZ` | `now() + 120 s`, set by the database. Must be after `created_at` |
| | `paid_at`, `expired_at`, `collected_at` | Must agree with `status` (CHECK constraints) |
| `order_items` | `order_id`, `product_id` | Foreign keys. One line per product per order (`UNIQUE`) |
| | `quantity INTEGER` | `> 0` |
| | `unit_price_paise INTEGER` | Price **snapshot** at order time. Later price changes do not affect the order. |

`payment_events` (migration `0004_create_payment_events.sql`):

| Column | Rules |
| ------ | ----- |
| `event_id TEXT` | **`UNIQUE`**, not blank. This is the idempotency key. |
| `order_id UUID` | Foreign key to `orders`. Indexed. |
| `amount_paise INTEGER`, `status TEXT` | As reported (`> 0`; `captured` / `failed`) |
| `outcome TEXT`, `detail TEXT` | What the application did and why (`CHECK` on the allowed outcomes) |
| `raw_payload TEXT` | The exact signed body, for audit |
| `received_at TIMESTAMPTZ` | Default `now()` |

**Status model.** All five statuses exist now, because the stock formula already depends on `paid` and `collected`.

| Status | Holds stock? | Set by |
| ------ | ------------ | ------ |
| `pending` | Yes, while `expires_at > now()` | `POST /orders` |
| `paid` | Yes, until collected | A captured payment received in time with the exact amount (signed webhook or dev simulator) |
| `expired` | No | An unpaid order past `expires_at`, stored by the expiry sweep or by `GET /orders/:id` |
| `needs_review` | No. For example, payment arrived after expiry; a person decides. | A late or mismatched payment (signed webhook or dev simulator) |
| `collected` | No. Physical stock was decremented at pickup. | `POST /orders/:id/collect`, only from `paid` |

**Physical stock vs. reservations.** `products.stock_quantity` changes only at collection (`POST /orders/:id/collect`). Creating or paying for an order does not touch it.
- Collection moves units from "reserved by a paid order" to "gone from the shelf" in one transaction, so availability does not change and nothing is subtracted twice.
- Lifecycle for an order of 3 from stock 10:
  - pending or paid: `stock 10 · reserved 3 · available 7`
  - collected: `stock 7 · reserved 0 · available 7` Reservations are derived from orders in the `product_availability` view:

```
available_units = max(stock_quantity − Σ quantity of (pending AND expires_at > now()) OR paid orders, 0)
```

Both `GET /products` and order creation use this single definition.

**Expiry.**
- Availability never depends on a background job. An unpaid order stops reserving stock the instant `expires_at <= now()`, because every query checks the deadline.
- To keep the *stored* status accurate too, the API runs an in-process sweep every `ORDER_EXPIRY_SWEEP_INTERVAL_MS` (default 15 s). `GET /orders/:id` also persists `expired` when it reads an overdue order.
- Both use `WHERE status = 'pending' AND expires_at <= now()`, so they can never overwrite a paid order.

### How order creation prevents overselling

All steps run in one transaction (`READ COMMITTED`, PostgreSQL's default isolation level):

1. `SELECT … FROM products WHERE id = ANY($1) ORDER BY id FOR UPDATE`. This locks every requested product row, always in id order, so two multi-product orders cannot deadlock.
2. A **new** statement recalculates availability from `product_availability`.
3. Insert the order, then all its items, then `COMMIT`. Any error rolls back the whole transaction, so there are never partial orders or orphaned items.

Why two customers can never both get the last unit:
- Every transaction that adds reservations for a product holds that product's row lock until it commits.
- The second customer's transaction therefore waits at step 1 until the first has committed.
- Under `READ COMMITTED` each new statement takes a fresh snapshot of committed data, so the second transaction's step 2 sees the first order's reserved units and gets `409`.
- Expiry decisions use `now()`, the transaction's start time. A slightly older instant can only make a reservation look *still active*, never release stock early.
- `lock_timeout = 5s` keeps transactions short.

## Seeding

```bash
docker compose exec backend npm run seed
```

- Inserts 5 snacks with fixed UUIDs using `ON CONFLICT DO NOTHING`. Running it again inserts nothing and **never overwrites** existing rows, so live stock levels are safe.
- Refuses to run when `NODE_ENV=production`, or when the connected database (checked with `current_database()`) is not `pickup_counter` or a name ending in `_dev` or `_test`.
- The Docker dev container runs it automatically on startup.

### Error format

Every error response has this shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Request validation failed.", "details": [...] } }
```

Unexpected errors are logged on the server and returned as a generic `500 INTERNAL_ERROR`. Stack traces and internal messages are never sent to clients.

---

## Development without Docker for the app (optional)

Run only the database in Docker and the apps on your machine:

```bash
docker compose up -d db

cd backend
export DATABASE_URL=postgres://pickup:pickup_dev_password@localhost:5433/pickup_counter
npm install && npm run migrate && npm run dev

cd ../frontend
npm install && npm run dev        # proxies /api to http://localhost:4000 by default
```

### Scripts

| Backend             | Purpose                                   |
| ------------------- | ----------------------------------------- |
| `npm run dev`       | API with live reload (tsx watch)          |
| `npm run build`     | Compile to `dist/`                        |
| `npm start`         | Run compiled API                          |
| `npm run migrate`   | Apply pending migrations                  |
| `npm run seed`      | Insert development data                   |
| `npm run typecheck` | `tsc --noEmit`                            |
| `npm run lint`      | ESLint (type-aware)                       |
| `npm test`          | Integration tests (needs `TEST_DATABASE_URL`) |
| `npm run webhook:send -- …` | Send a signed payment webhook (needs `PAYMENT_WEBHOOK_SECRET`) |

| Frontend            | Purpose                       |
| ------------------- | ----------------------------- |
| `npm run dev`       | Vite dev server on :5173      |
| `npm run build`     | Typecheck + production build  |
| `npm run typecheck` | `tsc --noEmit`                |
| `npm run lint`      | ESLint                        |
| `npm test`          | Component tests (Vitest + jsdom + Testing Library) |

### Frontend tests

```bash
cd frontend && npm test
```

Component tests render the real `<App />` in jsdom.
- HTTP is mocked at the `fetch` level (`src/test/mockApi.ts`), which records each request so the tests can assert exactly what the browser sends.
- They cover:
  - catalog loading, error and empty states
  - quantity limits
  - order creation (exact request body, no double submit)
  - `409` stock conflicts and validation errors
  - all five statuses
  - polling that stops at a final status
  - the countdown triggering a re-check at zero
  - "paid" shown only after `GET /orders/:id` confirms it
  - late payments
  - the simulator turned off
  - collection, including `alreadyCollected`, `ORDER_NOT_COLLECTABLE`, `INSUFFICIENT_PHYSICAL_STOCK` and `COLLECTION_BUSY`
- Dev dependencies added: `vitest`, `jsdom` and `@testing-library/*`. All are dev-only, so none of them end up in the browser bundle.
- These tests complement the backend's real-PostgreSQL integration suite; they do not replace it.

### Tests

Tests use a **real PostgreSQL database** named `pickup_counter_test`. It is created automatically the first time the `db` volume is initialised (`docker/postgres/init/01-create-test-db.sql`).

- Before each run, `tests/globalSetup.ts` drops and recreates the test schema, then runs all migrations. Every run therefore proves the migrations work on a fresh database.
- Tests that need a clean slate call `resetDomainTables()`. It empties **every** application table in one `TRUNCATE`, so foreign keys between tables never block cleanup and future tables are covered automatically. `schema_migrations` is kept.
- Constraint tests run inside transactions that are always rolled back.
- **Concurrency tests** use real overlapping transactions. A separate connection holds a row lock, the test waits until `pg_stat_activity` shows every request blocked on it at once, and then releases the lock. The payment service tags its locking queries (`/* payment:lock-order */`, `/* payment:lock-products */`) so the tests can see exactly where requests are waiting.
- Webhook tests sign with a fixed test-only `PAYMENT_WEBHOOK_SECRET` from `vitest.config.ts`. They compute the HMAC independently of the app's signing code.

```bash
# Inside Docker (TEST_DATABASE_URL is already set):
docker compose exec backend npm test
docker compose exec backend npx vitest run tests/payments.test.ts   # webhook tests only

# From your machine:
TEST_DATABASE_URL=postgres://pickup:pickup_dev_password@localhost:5433/pickup_counter_test npm test
```

#### Test database safety

The test setup drops the whole `public` schema, so it is guarded in layers (`tests/helpers/testDatabase.ts`). Any failed check stops the run **before** destructive SQL is sent.

1. **Explicit configuration.** `TEST_DATABASE_URL` must be set. There is never a fallback to `DATABASE_URL`.
2. **Expected target**, checked before connecting:
   - The scheme must be `postgres://` or `postgresql://`.
   - The database name must be exactly `pickup_counter_test`.
   - The host:port must be `db:5432` (inside Docker) or `localhost` / `127.0.0.1` / `[::1]` on `POSTGRES_HOST_PORT` (default 5433).
   - The URL must have no query parameters, because `?host=` could silently redirect the connection.
3. **Marker.** On the same connection that will run the destructive SQL, `current_database()` must be `pickup_counter_test`. The database must also carry the comment `pickup-counter:disposable-test-database`. The init script sets this comment when it creates the database. It lives in the server catalog, so it survives the schema reset.
4. **Test-run lock.** `globalSetup` keeps one dedicated connection open in the main Vitest process and holds `pg_try_advisory_lock(727002)` on it until the final teardown.
   - A second, overlapping run fails immediately with "Another test run is using the test database".
   - If a run crashes, its connection closes and PostgreSQL releases the lock automatically.

Error messages name the target as `host:port/database` only, never the credentials.

**One-time setup for volumes created before the marker existed.** Run this if tests stop with *"is not marked as a disposable test database"*. It only adds the comment, and no data changes:

```bash
docker compose exec db psql -U pickup -d postgres \
  -c "COMMENT ON DATABASE pickup_counter_test IS 'pickup-counter:disposable-test-database'"
```

If the test database does not exist at all (a very old volume), create it first:
`docker compose exec db psql -U pickup -d postgres -c "CREATE DATABASE pickup_counter_test"`.

Only ever put this marker on a database whose contents may be destroyed.

### Changing the database password

PostgreSQL reads `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB` **only when the data volume is first created**. Changing them later, for example by adding a `.env` with a different password, does **not** change the existing database. The backend then gets `password authentication failed for user "pickup"` (error `28P01`) and stays unhealthy.

The local default is `pickup_dev_password` everywhere: Compose defaults, `.env.example` and the README. If login fails, recover without deleting data. Choose **one** of these:

- **Go back to the password the volume was created with.** Remove the changed `POSTGRES_PASSWORD` from `.env`, or set it back.
- **Change the stored password to match your `.env`.** Connections from inside the `db` container use local trust auth, so no old password is needed:
  ```bash
  docker compose exec db psql -U pickup -d postgres -c "ALTER ROLE pickup PASSWORD 'your_new_password'"
  docker compose up -d backend
  ```

`docker compose down -v` also "fixes" it, but it **deletes all data**. Use it only when you want an empty database.

### Port 5433 conflicts on the host

Inside Docker the backend always uses `db:5432`; the host port only matters for publishing. Ports are published on `127.0.0.1`, so if another program on your machine already listens on 5433, `docker compose up` **fails to start** the database with an error like:

```
ports are not available: exposing port TCP 127.0.0.1:5433 … bind: An attempt was made to access a socket in a way forbidden by its access permissions
```

To use a free port, set `POSTGRES_HOST_PORT` (for example `5434`) in `.env`, or on the command line (`POSTGRES_HOST_PORT=5434 docker compose up -d`). Use the same port in host-side `DATABASE_URL` / `TEST_DATABASE_URL`, and export `POSTGRES_HOST_PORT` for host-side tests so the test-database guard accepts it. The marker check still refuses to reset an unmarked database if a URL ever points at another server.

---

## How concurrency was tested

Every concurrency test runs against the **real PostgreSQL** test database (`pickup_counter_test`), with no mocks. To make sure the requests genuinely overlap:
1. A separate connection first holds the relevant row lock.
2. The test fires the requests, then waits until `pg_stat_activity` shows **all of them blocked inside PostgreSQL at the same moment**.
3. Only then does it release the lock.

The assertions check the final database state, not just HTTP codes.

**The three concurrency tests required by the brief:**

| Brief scenario | Test (exact name) | What it proves |
| --- | --- | --- |
| Ten simultaneous customers compete for the last two units | `backend/tests/orders.test.ts`: "ten customers racing for the last two units: exactly two succeed" | 10 overlapping `POST /orders` for 2 units give exactly 2 × 201 and 8 × 409 `INSUFFICIENT_STOCK`; the database shows stock 2, reserved 2, available 0, exactly 2 orders, and no order without items |
| The same webhook event is delivered twice | `backend/tests/payments.test.ts`: "the same webhook event delivered twice simultaneously is applied exactly once" | Two overlapping deliveries of one signed event both get 200: one applies it (`duplicate: false`), the other is acknowledged (`duplicate: true`). One `payment_events` row; the order is paid once; stock is untouched. |
| Two pickup claims arrive simultaneously | `backend/tests/collection.test.ts`: "two simultaneous pickup claims: exactly one succeeds, the other gets 409" | One claim gets 200 (collected) and the other 409 `ORDER_ALREADY_COLLECTED`; stock is deducted exactly once (10 → 7 for 3 units) |

**Related tests:**
- 5 simultaneous copies of one event, two distinct events racing for one order, and the same `eventId` racing for two orders (hits the `UNIQUE` constraint)
- concurrent `/collect`, two orders collecting the same product without losing an update, and opposite lock orders without deadlock
- a payment waiting for an in-flight order creation, and a real deadlock reported as a retryable 503

**Proof the tests catch real bugs (mutation checks).** During development, the safeguards were removed one at a time:
- moving the availability check before the row lock gave 10 × 201 for 2 units
- removing the order lock and the status guard in collection deducted stock twice
- removing the pickup-claim 409 branch gave `[200, 200]`

Each time the relevant test failed. The code was then restored.

## Assumptions

- **Single counter, local demo.** There are no user accounts, staff login or pickup PIN, because the brief defines none (see [Security notes](#security-notes)). Order IDs are random UUIDs.
- **Prices are fixed per order.** Each order stores a price snapshot, so later catalog changes do not alter it.
- **Reservations last 120 s from database time.** The browser's clock is never used.
- **Payments come from a provider via a signed webhook.** The browser "Simulate payment" button is development-only and runs the same server-side rules.
- **Late or wrong-amount payments are not refunded automatically.** They become `needs_review` for a person to resolve; see [Outcomes](#outcomes) for the exact policy.
- **Physical stock leaves the shelf at pickup**, not at payment.
- **Retries are left to the client.** A 503 `*_BUSY` response is safe to retry; the server never retries automatically.

## What I would improve next

- **Staff authentication** (or a pickup code shown to the customer) for `pickup-claim`, and an admin view for `needs_review` orders, including a refund workflow.
- **A timestamp in the webhook signature**, with a replay window, as most payment providers use.
- **Production frontend serving:** serve the built `frontend/dist` (for example from nginx) instead of the Vite dev server in Compose.
- **Live catalog updates** (polling or server-sent events), so other customers' reservations show without pressing Refresh.
- **Observability:** structured logs and metrics for reservations, expiries, payment outcomes and lock contention.
- **A deterministic test for the exact 120 s payment-vs-new-order boundary.** Today it is covered by the lock-ordering design plus a lock-wait test.

## Decisions log

| # | Decision | Why |
| - | -------- | --- |
| 1 | Money stored as integer **paise** (`BIGINT`/`INTEGER`), never floats | Floating-point cannot represent 0.1 exactly; integers are exact. |
| 2 | PostgreSQL is the source of truth; concurrency handled with transactions + row locks / conditional `UPDATE`s | Several customers can buy the last item at once; only the DB can arbitrate safely. |
| 3 | Express 5 | Errors thrown in async handlers reach the error handler automatically. |
| 4 | Small in-house SQL migration runner (advisory lock + one transaction per file + `schema_migrations` table) | Zero extra dependencies; plain SQL is easy to review. |
| 5 | Zod for env and request validation | One library, TypeScript types inferred from schemas. |
| 6 | Frontend calls same-origin `/api`, proxied by Vite | No CORS; same URLs work in Docker and locally. `API_PROXY_TARGET` has no `VITE_` prefix, so it is never bundled into browser code. |
| 7 | `/health` checks the database (`SELECT 1`), returning 200 or 503 | A container that cannot reach its DB is not healthy. |
| 8 | Postgres published on host port **5433** | Avoids clashing with a locally installed PostgreSQL on 5432. |
| 9 | Compose has local-only fallback credentials | `docker compose up --build` works on a fresh clone; real secrets never live in the repo. |
| 10 | Integration tests run against a dedicated `_test` database, files run sequentially | Real DB behaviour (locks, constraints) without risking dev data. |
| 11 | `price_paise` and `stock_quantity` are `INTEGER`, not `BIGINT` | node-postgres returns `BIGINT` as a string; `INTEGER` arrives as a JS number and holds up to about Rs 2.1 crore. |
| 12 | Data rules live in DB `CHECK` constraints and a unique index on `lower(name)` | The database is the last line of defence, whatever code writes to it. |
| 13 | `availableUnits` is computed in SQL in `products.service.ts` | Phase 3 changes it to "stock minus active reservations" in one place. |
| 14 | Seed uses fixed UUIDs + `ON CONFLICT DO NOTHING` and a database-name guard | Repeatable, never clobbers live stock, cannot seed an arbitrary database. |
| 15 | `GET /products` returns `{ "products": [...] }`, not a bare array | Room to add fields (e.g. pagination) later without breaking clients. |
| 16 | Test DB guarded by config allow-list + database-comment marker + verified connection + session advisory lock held for the whole run | Defence in depth: a wrong URL, wrong server, unmarked DB or overlapping run all fail before any destructive SQL. |
| 17 | One local default password (`pickup_dev_password`) in Compose and `.env.example`, checked by `tests/config.test.ts` | Copying `.env.example` must never lock the backend out of an existing volume. |
| 18 | Reservations derived from orders (view `product_availability`); `stock_quantity` changes only at collection | No counter to drift: an expired order frees stock instantly, without a job having to "give stock back". |
| 19 | `SELECT … FOR UPDATE` on product rows in id order, then recheck availability in a new statement | Serialises competing orders per product; consistent lock order prevents deadlocks. Verified by a 10-customer test that fails when the recheck is moved before the lock. |
| 20 | Expiry = `expires_at <= now()` in every query, plus an in-process sweep and on-read reconciliation that only touch `pending` | Correct without the sweep; the sweep only tidies stored status and can never overwrite `paid`. |
| 21 | Duplicate product IDs in one order are rejected (400), not merged | The client sees exactly what was ordered; no hidden quantity changes. |
| 22 | Limits: ≤ 20 line items, quantity 1–20, total must fit `INTEGER` paise | Bounds work per request and guarantees safe integer arithmetic. |
| 23 | `needs_review` holds no stock | A late payment must not silently re-reserve units already sold to someone else; staff resolve it. |
| 24 | Webhook signature = HMAC-SHA256 over the raw body, header `X-Pickup-Signature: sha256=<hex>`, raw parser only on the webhook path | Verifies the exact bytes; JSON parsing happens only after authentication. |
| 25 | Idempotency via `UNIQUE (event_id)` in the same transaction as the order update | Durable and race-safe without Redis or memory state; nothing half-applied. |
| 26 | Payment locks the order row **and** its product rows, then decides with `clock_timestamp()` | Serialises the deadline decision with competing order creation, so a boundary-time payment can never revive units already re-sold. |
| 27 | Unknown-order events return 404 and are not stored | `payment_events.order_id` is a foreign key; there is no order to attach them to. |
| 28 | `amount_mismatch` / `late_payment` → `needs_review`; no automatic refund | Money problems need a person; the system never claims a refund it cannot perform. |
| 29 | Collection locks the order row, re-checks status, locks products in id order, guarded deduction + guarded status update, one transaction | Exactly-once physical stock deduction under concurrency; same lock order as creation and payment, so no deadlocks. |
| 30 | Repeat collection returns 200 with `alreadyCollected: true` | Idempotent for staff retries and double-clicks; mirrors the webhook's `duplicate: true`. |
| 31 | Shelf shortage at pickup → 409 `INSUFFICIENT_PHYSICAL_STOCK`, order stays `paid` | A write-off after payment must not silently hand over a partial order; staff resolve it. |
| 32 | No new migration for Phase 5 | `collected_at` and its `CHECK` constraints already existed (0003); old migrations are never edited. |
| 33 | Browser "pay" goes through a dev-only server endpoint that calls the normal payment service; the secret never reaches the browser | Client-side signing would leak the secret; a public mark-as-paid endpoint would bypass the payment rules. |
| 34 | Order ID kept in the URL hash, not localStorage | Survives reloads and can be shared; stores no data in the browser. |
| 35 | Countdown anchored to the server's `expiresInSeconds` at response time; zero triggers a server re-check | Device clocks are never trusted; the server decides expiry. |
| 36 | No UI library or state manager; plain React state and hooks | The app has two panels and five endpoints; extra dependencies would add weight without benefit. |
| 37 | `POST /orders/:id/pickup-claim` (brief) returns 409 to the competing claim; `/collect` kept as the idempotent 200 variant | Matches the brief exactly without breaking the earlier route; both share one exactly-once service. |

## Security notes

- `.env` is gitignored. `.env.example` contains placeholders only.
- All SQL uses parameter placeholders (`$1`, `$2`, ...). User input is never concatenated into SQL.
- Env validation errors print variable names only, never values.
- `x-powered-by` is disabled; JSON bodies are limited to 100 kB.

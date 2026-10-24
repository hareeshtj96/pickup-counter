# Pickup Counter

A full-stack TypeScript app for reserving snacks, paying, and collecting them at a counter. Stock is reserved for 120 seconds, payments arrive through an HMAC-signed webhook, and pickup deducts physical stock exactly once, even under concurrent requests.

| Layer | Technology |
| --- | --- |
| Backend | Node.js 22, Express 5, TypeScript (strict), Zod |
| Database | PostgreSQL 16 via `pg` (parameterized SQL only) |
| Frontend | React 19, Vite 6, TypeScript (strict) |
| Tests | Vitest + Supertest against a **real PostgreSQL** database; Vitest + Testing Library for the UI |
| Runtime | Docker + Docker Compose |

**Status:** the full flow (catalog → reservation → signed payment → pickup claim) is implemented and covered by automated tests, including the three required concurrency tests ([below](#the-three-required-concurrency-tests)). The original assignment brief is not stored in this repository: the implementation has been checked against the requirements documented here and in [docs/FINAL_AUDIT.md](docs/FINAL_AUDIT.md), which is not a verification against the original text. Known limitations are listed [below](#assumptions-limitations-and-next-steps).

---

## Quick start

**Prerequisites:**
- **Docker Desktop**, running. This is all you need to start the app and run the backend tests.
- **Node.js ≥ 22**, *only* for commands run directly on your machine (frontend tests, typecheck/lint/build). Run `npm ci` in `backend/` and/or `frontend/` first.

```bash
docker compose up --build
```

No `.env` file is needed: Compose falls back to local-only defaults (see `.env.example`).

| Service | Address |
| --- | --- |
| Frontend | http://localhost:5173 |
| API health | http://localhost:4000/health |
| PostgreSQL | `localhost:5433`, database `pickup_counter`, user `pickup`, local placeholder password from `.env.example` |

- All ports are published on **127.0.0.1 only**. Containers reach each other as `db:5432` and `backend:4000`.
- If port 5433 is already taken on your machine, set `POSTGRES_HOST_PORT` (for example `5434`) in a local `.env`. See [troubleshooting](docs/TECHNICAL_DETAILS.md#port-5433-conflicts-on-the-host).

**Check it is running:**

```bash
docker compose ps                         # db, backend, frontend all "healthy"
curl -i http://localhost:4000/health      # 200 {"status":"ok","database":"up",...}
curl -i http://localhost:4000/products    # 200, the 5 seeded snacks
```

**Stop:**

```bash
docker compose down        # stop containers, keep database data
docker compose down -v     # WARNING: also deletes the database volume and all data
```

---

## Architecture

```
Browser ──► frontend (Vite :5173) ──/api proxy──► backend (Express :4000) ──► db (PostgreSQL :5432)
```

- **The browser only calls `/api/...` on its own origin.** Vite proxies those calls to the backend, so no CORS setup is needed.
- **Backend request flow:** `route → validation middleware → controller → service → PostgreSQL`, with one transaction per state change.
- **PostgreSQL is the source of truth** for stock, reservations, payments and order status. The browser only displays what the server returns.
- **Startup order:**
  1. `db` becomes healthy.
  2. `backend` applies migrations, seeds the 5 products (idempotent) and passes `GET /health`.
  3. `frontend` starts.

Details: [docs/TECHNICAL_DETAILS.md](docs/TECHNICAL_DETAILS.md#architecture).

---

## Customer workflow

1. **Browse:** the catalog shows each snack's price and its *available* units (stock minus active reservations).
2. **Reserve:** choose quantities with the per-product controls. These controls and the order summary below them (item count, estimated total) are the **in-page cart**; there is no separate cart page. Press *Reserve for 2 minutes* to submit the selection as one order. The server reserves the stock atomically for **120 seconds**, and the page counts down from the server-provided `expiresInSeconds`.
3. **Pay:**
   - In production, the payment provider calls the signed webhook.
   - Locally, *Simulate payment* asks the backend to run that same payment logic. This is a development-only endpoint; the browser never holds the webhook secret.
   - A late payment, or one with the wrong amount, sets the order to `needs_review`.
4. **Pick up:** staff press *Confirm pickup*. The server deducts physical stock **exactly once**; a competing claim gets 409.

The order ID is kept in the URL (`#/orders/<id>`), so a reload or shared link reopens the order.

---

## API

All routes are also served under `/api` (for example `/api/products`). Errors always have the shape `{ "error": { "code", "message", "details"? } }`. The full reference is in [docs/TECHNICAL_DETAILS.md](docs/TECHNICAL_DETAILS.md#api-reference).

| Endpoint | Purpose | Key responses |
| --- | --- | --- |
| `GET /products` | Catalog with `pricePaise` (integer) and `availableUnits` | 200 |
| `POST /orders` | Reserve stock for 120 s. Body: `{"items":[{"productId","quantity"}]}` | 201 with `expiresInSeconds`; 409 `INSUFFICIENT_STOCK`; 400; 422; 503 (retryable) |
| `GET /orders/:id` | Current status, total, items, remaining reservation time | 200; 404 |
| `POST /payments/webhook` | Payment provider callback, HMAC-SHA256 signed in the **`X-Signature`** header (bare hex digest or `sha256=<hex>`) | 200 (including duplicates, with `"duplicate": true`); 401 missing, malformed or invalid signature; 400; 404 |
| `POST /orders/:id/pickup-claim` | Staff confirm pickup of a **paid** order | **200** first claim; **409** `ORDER_ALREADY_COLLECTED` for the competing or any later claim; 409 `ORDER_NOT_COLLECTABLE` if not paid; 415 without a JSON `Content-Type` |
| `POST /orders/:id/collect` | Idempotent variant of `pickup-claim`: a repeat returns 200 with `"alreadyCollected": true` instead of 409 | 200; 409; 415 |
| `GET /health` | Liveness, including a database check | 200; 503 |

`pickup-claim` and `collect` take no body but require `Content-Type: application/json`, so other websites can't trigger them blindly:

```bash
curl -X POST http://localhost:4000/orders/<id>/pickup-claim -H 'Content-Type: application/json' -d '{}'
```

**Paying an order locally** with a correctly signed webhook (the secret is already set inside the container):

```bash
docker compose exec backend npm run webhook:send -- --order <orderId> --amount <totalPaise>
docker compose exec backend npm run webhook:send -- --order <orderId> --amount <totalPaise> --repeat 2   # same event twice
docker compose exec backend npm run webhook:send -- --order <orderId> --amount <totalPaise> --signature-format sha256   # send "sha256=<hex>"
```

**Signature header:** `X-Signature` is the only header read. Its value is the lowercase hex HMAC-SHA256 of the exact request body, either as the bare 64-character digest or as `sha256=` followed by it. The format is validated strictly and compared with `crypto.timingSafeEqual`; a missing, malformed or wrong signature gets 401 before anything is read or changed. Details and a hand-signed `curl` example: [docs/TECHNICAL_DETAILS.md](docs/TECHNICAL_DETAILS.md#signature-verification).

---

## Correctness decisions

| Decision | How |
| --- | --- |
| **Money is integer paise** | `INTEGER` columns (`price_paise`, `total_paise`, `unit_price_paise`); totals summed as integers; the UI formats rupees with integer arithmetic. Each order stores a price snapshot. |
| **120-second reservations** | `expires_at = now() + 120 s`, set by the database. Availability is `stock − (unexpired pending + paid uncollected)`, recalculated in every query, so an expired order frees stock instantly without waiting for a background job. |
| **No overselling** | One transaction: lock the product rows with `SELECT … FOR UPDATE` (always in id order), recheck availability, then insert. `lock_timeout` and deadlocks return a retryable 503. |
| **Signed webhook** | HMAC-SHA256 over the **raw request body** (header `X-Signature`: bare hex digest or `sha256=<hex>`), format-checked and compared with `crypto.timingSafeEqual`. The secret comes from `PAYMENT_WEBHOOK_SECRET` (required, ≥ 32 chars). |
| **Durable idempotency** | `UNIQUE (event_id)`, written in the same transaction as the order update, under an order-row lock. Duplicates get 200 with `"duplicate": true`, and nothing is applied twice. |
| **Late or incorrect payments** | A late payment or wrong amount sets the order to `needs_review`. It never revives released stock, and **no refund is issued automatically**: a person resolves it. Full policy: [payment outcomes](docs/TECHNICAL_DETAILS.md#outcomes-payment-policy). |
| **Exactly-once pickup** | Lock the order, re-check that it is `paid`, lock its products, deduct with guarded `UPDATE`s, set `collected`, all in one transaction. Physical stock changes **only** at pickup. |
| **Server-derived timing** | `expiresInSeconds` is calculated from database time. The UI counts down from it relative to when the response arrived, never from the device clock, and re-checks with the server at zero. |

Transaction and lock sequences, the schema, constraints and the full decisions log are in [docs/TECHNICAL_DETAILS.md](docs/TECHNICAL_DETAILS.md).

---

## The three required concurrency tests

All three run against the **real PostgreSQL** test database. Each test holds a row lock and waits until `pg_stat_activity` shows **every request blocked inside PostgreSQL at the same moment**, then releases the lock. The assertions check the final database state as well as the HTTP codes.

| Scenario | Test file and exact name | Verified outcome |
| --- | --- | --- |
| Ten simultaneous customers, last two units | `backend/tests/orders.test.ts`: **"ten customers racing for the last two units: exactly two succeed"** | Exactly 2 × 201 and 8 × 409 `INSUFFICIENT_STOCK`; the database shows stock 2, reserved 2, available 0, and no order without items |
| The same webhook event delivered twice | `backend/tests/payments.test.ts`: **"the same webhook event delivered twice simultaneously is applied exactly once"** | Both 200, one `duplicate: false` and one `duplicate: true`; one `payment_events` row; the order is paid once |
| Two simultaneous pickup claims | `backend/tests/collection.test.ts`: **"two simultaneous pickup claims: exactly one succeeds, the other gets 409"** | One 200 and one 409 `ORDER_ALREADY_COLLECTED`; stock deducted exactly once (10 → 7 for 3 units) |

```bash
docker compose exec backend npx vitest run -t "ten customers racing"
docker compose exec backend npx vitest run -t "delivered twice simultaneously"
docker compose exec backend npx vitest run -t "two simultaneous pickup claims"
```

To show these tests catch real bugs, safeguards were removed temporarily and the tests re-run, and the code was restored afterwards. For example, reading availability before the row lock gave 10 successful orders for 2 units, and removing the 409 branch gave `[200, 200]`. See [docs/TESTING.md](docs/TESTING.md#mutation-checks).

---

## Running the tests

```bash
# Backend: real-PostgreSQL integration tests (needs the stack running; nothing to install)
docker compose exec backend npm test

# Frontend: component tests (needs Node.js >= 22 and `npm ci` in frontend/)
cd frontend && npm test

# Static checks, in backend/ or frontend/
npm run typecheck && npm run lint && npm run build
```

**Test database safety:**
- Backend tests use only the dedicated `pickup_counter_test` database, never the development data.
- Before the setup drops and recreates the test schema, it verifies the exact database name, the host/port, a marker comment on the database, and the live connection's identity. It also takes an advisory lock so two test runs can't overlap.

Running from the host, safety details and troubleshooting: [docs/TESTING.md](docs/TESTING.md).

---

## AI usage

Built with **Claude Code** (implementation, tests, debugging, verification) and **ChatGPT** (drafting and refining prompts, reviewing reports, discussing design). [AI_NOTES.md](AI_NOTES.md) covers how they were used, a prompt that worked well, and a real AI error with how it was caught and fixed.

## Assumptions, limitations and next steps

**Assumptions:**
- **A single counter, run as a local demo.** There are no user accounts, staff login or pickup PIN, because the requirements given for this project define none. Order IDs are random UUIDs.
- **Payments come from a provider via the signed webhook.** The browser's *Simulate payment* uses a development-only endpoint (`DEV_PAYMENT_SIMULATOR`), which is off by default and refused in production.
- **A 503 `*_BUSY` response is safe to retry.** The server never retries automatically.

**Limitations:**
- `pickup-claim` is unauthenticated.
- Webhook signatures carry no timestamp; replays are harmless thanks to idempotency.
- In Compose, the frontend runs on the Vite dev server.
- The catalog refreshes after actions, not live.

**What I would improve next:**
- staff authentication (or a customer pickup code), and an admin view with a refund workflow for `needs_review` orders
- a timestamped webhook signature
- serving the built frontend (for example via nginx)
- live catalog updates
- structured logs and metrics
- a deterministic test for the exact 120 s payment-vs-new-order boundary

---

## Further documentation

| Document | Contents |
| --- | --- |
| [docs/TECHNICAL_DETAILS.md](docs/TECHNICAL_DETAILS.md) | Full API reference and error tables, webhook processing and payment outcomes, schema and constraints, transaction/lock sequences, frontend behaviour, dev simulator, configuration and troubleshooting, decisions log, security notes |
| [docs/TESTING.md](docs/TESTING.md) | Test suites, host-side test commands, the test-database safety guard, concurrency methodology, mutation checks, troubleshooting |
| [docs/FINAL_AUDIT.md](docs/FINAL_AUDIT.md) | Final engineering audit: compliance matrix, security and concurrency findings, fixes applied |
| [AI_NOTES.md](AI_NOTES.md) | AI tools used, a prompt that worked well, a real AI error |

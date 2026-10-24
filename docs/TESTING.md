# Testing

How the Pickup Counter tests are run, how the real-PostgreSQL test database is protected, and how the concurrency tests prove genuine overlap. For the short version, see the [README](../README.md#running-the-tests).

- [Test suites](#test-suites)
- [Running the tests](#running-the-tests)
- [The test database and its safety guard](#the-test-database-and-its-safety-guard)
- [How concurrency is tested](#how-concurrency-is-tested)
- [Mutation checks](#mutation-checks)
- [Troubleshooting](#troubleshooting)

---

## Test suites

| Suite | Location | Runs against | Tool |
| --- | --- | --- | --- |
| Backend integration | `backend/tests/*.test.ts` | A **real PostgreSQL** database, `pickup_counter_test`, through the real Express app | Vitest + Supertest |
| Frontend components | `frontend/src/**/*.test.ts(x)` | The real `<App />` in jsdom, with HTTP mocked at the `fetch` level | Vitest + Testing Library |

**Backend.**
- Every endpoint is exercised over HTTP against the real database: products, orders, reservations and expiry, the signed webhook, the dev simulator, `pickup-claim` and `collect`, and content-type checks.
- The suite also covers migrations and constraints, the test-database guard, config consistency (`.env.example` vs Compose defaults), health and error handling.
- **No database mocks are used anywhere.**

**Frontend.**
- `src/test/mockApi.ts` replaces `fetch` with a small router that records every request (method, path, body), so the tests can assert exactly what the browser sends.
- They cover:
  - catalog loading, error and empty states
  - quantity limits
  - order creation (exact request body, no double submit)
  - `409` stock conflicts and validation errors
  - all five statuses
  - polling that stops at a final status
  - the countdown re-check at zero, with no request burst when the server still reports 0 s
  - "paid" shown only after `GET /orders/:id` confirms it
  - late payments
  - the simulator turned off
  - pickup claims, including `409 ORDER_ALREADY_COLLECTED`, `ORDER_NOT_COLLECTABLE`, `INSUFFICIENT_PHYSICAL_STOCK` and `COLLECTION_BUSY`
- These tests complement the backend suite; they do not replace it.

## Running the tests

**Backend, inside Docker (recommended).** This needs only Docker; the stack must be running (`docker compose up --build`). `TEST_DATABASE_URL` is already set in the container.

```bash
docker compose exec backend npm test
docker compose exec backend npx vitest run tests/payments.test.ts     # one file
docker compose exec backend npx vitest run -t "ten customers"         # tests matching a name
```

**Backend, from your machine.** This needs Node.js ≥ 22 and `npm ci` in `backend/`.
- The test database is reached through the **host** port of the Compose database: `5433` by default, or your `POSTGRES_HOST_PORT`.
- Export `POSTGRES_HOST_PORT` as well when it is not 5433, so the safety guard accepts that port.

```bash
cd backend
TEST_DATABASE_URL=postgres://pickup:pickup_dev_password@localhost:5433/pickup_counter_test npm test

# with a custom host port, e.g. 5434:
POSTGRES_HOST_PORT=5434 TEST_DATABASE_URL=postgres://pickup:pickup_dev_password@localhost:5434/pickup_counter_test npm test
```

**Frontend.** This needs Node.js ≥ 22 and `npm ci` in `frontend/`; no database or running stack is required.

```bash
cd frontend && npm test
```

**Static checks** (both packages):

```bash
npm run typecheck && npm run lint && npm run build
```

## The test database and its safety guard

Tests use a dedicated database, `pickup_counter_test`. `docker/postgres/init/01-create-test-db.sql` creates it the first time the `db` volume is initialised.

**On each run:**
- Before any test, `tests/globalSetup.ts` drops and recreates the test schema, then runs all migrations. Every run therefore also proves the migrations work on a fresh database.
- Tests needing a clean slate call `resetDomainTables()`. It empties every application table in one `TRUNCATE`, so foreign keys never block cleanup and new tables are covered automatically. `schema_migrations` is kept.
- Constraint tests run inside transactions that are always rolled back.
- Webhook tests sign with a fixed, test-only `PAYMENT_WEBHOOK_SECRET` from `backend/vitest.config.ts`. They compute the HMAC independently of the app's signing code.

**The guard.** Because setup drops the whole `public` schema, it is guarded in layers (`backend/tests/helpers/testDatabase.ts`). Any failed check stops the run **before** destructive SQL is sent.

1. **Explicit configuration.** `TEST_DATABASE_URL` must be set. There is never a fallback to `DATABASE_URL`.
2. **Expected target**, checked before connecting:
   - the scheme is `postgres://` or `postgresql://`
   - the database name is exactly `pickup_counter_test`
   - the host:port is `db:5432` (inside Docker) or `localhost` / `127.0.0.1` / `[::1]` on `POSTGRES_HOST_PORT` (default 5433)
   - there are no query parameters, because `?host=` could silently redirect the connection
3. **Marker.** On the same connection that will run the destructive SQL, `current_database()` must be `pickup_counter_test`, and the database must carry the comment `pickup-counter:disposable-test-database`. The init script sets this comment. It lives in the server catalog, so it survives the schema reset.
4. **Test-run lock.** `globalSetup` keeps one connection open in the main Vitest process and holds `pg_try_advisory_lock(727002)` on it until teardown.
   - A second, overlapping run fails immediately with "Another test run is using the test database".
   - If a run crashes, its connection closes and PostgreSQL releases the lock.

Error messages name the target as `host:port/database` only, never the credentials. The development database is never touched by the tests.

## How concurrency is tested

Every concurrency test uses **real overlapping transactions** against the real test database. The method is the same each time:

1. A separate connection opens a transaction and **holds the relevant row lock** (an order row or a product row).
2. The test fires the concurrent requests at a real HTTP server.
3. It waits until `pg_stat_activity` shows **every request blocked inside PostgreSQL at the same moment**. Locking queries are tagged with SQL comments (`/* collect:lock-order */`, `/* payment:lock-order */`, `/* payment:lock-products */`) so the test knows exactly where they wait.
4. It releases the lock, so the requests genuinely race.
5. It asserts **both** the HTTP results and the final database state: stock, reserved units, rows written, and orphan checks.

**The three tests required by the project requirements:**

| Scenario | Test | Asserts |
| --- | --- | --- |
| Ten customers, last two units | `orders.test.ts`: "ten customers racing for the last two units: exactly two succeed" | statuses sorted = `[201, 201, 409 × 8]`; every 409 is `INSUFFICIENT_STOCK`; stock 2, reserved 2, available 0; 2 orders, 2 units in `order_items`, 0 orders without items |
| Same webhook event delivered twice | `payments.test.ts`: "the same webhook event delivered twice simultaneously is applied exactly once" | both 200; `duplicate` values `[false, true]`; both outcomes `paid`; 1 `payment_events` row; order `paid`; stock 10, reserved 2, available 8 |
| Two simultaneous pickup claims | `collection.test.ts`: "two simultaneous pickup claims: exactly one succeeds, the other gets 409" | statuses sorted = `[200, 409]`; the 409 is `ORDER_ALREADY_COLLECTED`; order `collected`; stock 7, reserved 0, available 7 (from 10, quantity 3) |

**Other concurrency tests:**
- *Orders:* multi-product orders listing their items in opposite order (no deadlock, no oversell); a 503 instead of waiting forever on a stuck lock; a real PostgreSQL deadlock reported as a retryable 503 `RESERVATION_BUSY`. PostgreSQL aborts whichever deadlocked session detects the cycle first, so the test gives its own session a long `deadlock_timeout` to make the API the only possible victim, and checks the response time to prove the 503 came from deadlock detection rather than the 5 s lock timeout.
- *Payments:* 5 simultaneous copies of one event; two distinct events for one order (one `paid`, one `already_paid`); the same `eventId` racing for two orders, where `UNIQUE (event_id)` gives one 200 and one 409 `EVENT_ID_CONFLICT`; a payment waiting for an in-flight order creation on the same products.
- *Collection:* two simultaneous `/collect` calls (stock deducted once); two orders collecting the same product (no lost update); multi-product collections in parallel (no deadlock).

## Mutation checks

To show that the concurrency tests catch real bugs, safeguards were removed temporarily and the relevant test run against the broken code. Each file was restored byte-for-byte afterwards, and no mutated code was kept.

| Safeguard removed | Result |
| --- | --- |
| Order creation: availability read **before** the product row lock | 10 × 201 for 2 units; the 10-customer test failed |
| Payment: order-row lock removed (10 ungated races) | Every race gave `paid` + `500`. The guarded status update blocked any double payment. |
| Collection: order-row lock removed | Stock still deducted once (the status guard caught it), but the loser got a 500 in 9 of 10 races |
| Collection: order-row lock **and** `status = 'paid'` guard removed | Stock deducted **twice** in 9 of 10 races |
| Pickup claim: the `alreadyCollected` → 409 branch | `[200, 200]`; the simultaneous-claims test failed |
| Deadlock mapping: `40P01` not treated as lock contention | A real deadlock returned 500; the deadlock test failed |
| Countdown: the "ran down from a positive value" guard | Extra immediate status requests; the regression test failed ("expected 3 to be 2") |

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `TEST_DATABASE_URL is not set` | Running from the host without the variable | Set it as shown in [Running the tests](#running-the-tests). There is deliberately no fallback. |
| `Refusing test database …: host:port must be one of …` | URL points at another host or port | Use the Compose database's host port; export `POSTGRES_HOST_PORT` if it isn't 5433 |
| `… is not marked as a disposable test database` | Volume created before the marker existed | Run the one-time command below |
| `database "pickup_counter_test" does not exist` | Very old volume | Create it, then add the marker (below) |
| `Another test run is using the test database` | A second run started while one is in progress | Wait for the first run to finish |
| `28P01 password authentication failed` from the host | The host port reaches a different PostgreSQL, or the password changed | See [Port conflicts and passwords](TECHNICAL_DETAILS.md#configuration-and-troubleshooting) |

One-time marker setup. It only adds a comment; no data changes:

```bash
docker compose exec db psql -U pickup -d postgres \
  -c "COMMENT ON DATABASE pickup_counter_test IS 'pickup-counter:disposable-test-database'"
```

If the test database does not exist yet, create it first:

```bash
docker compose exec db psql -U pickup -d postgres -c "CREATE DATABASE pickup_counter_test"
```

Only ever put this marker on a database whose contents may be destroyed.

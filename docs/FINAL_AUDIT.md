# Final Audit — Pickup Counter

Audit date: 2026-10-24. Audited commit: `f118639` (working tree clean at the start of the audit). No application code was changed by this audit.

Every result below comes from a command run during this audit, unless it is explicitly marked *previously executed* (earlier phases) or *inferred* (code reading only).

---

## 1. Executive summary

**Verdict: READY WITH LIMITATIONS**, measured against the requirements available in this repository and session. The original assignment document is not in the repository, so compliance with *that* document is **UNVERIFIED**. See §10.

**What was verified in this audit:**
- All backend tests pass: **165 / 165**, against real PostgreSQL.
- All frontend tests pass: **46 / 46**.
- Typecheck, lint and production builds pass for both apps.
- A **clean start from an empty database** works with the documented command:
  - The check used an isolated Compose project, so development data was untouched.
  - Migrations ran, products were seeded, the test database was created and marked, and all services became healthy in 58 s.
- The full workflow works on that fresh stack, through the API and through a real (headless Edge) browser.
- Live concurrency behaved correctly against the running API:
  - 10 simultaneous customers for 2 units gave exactly 2 × 201 and 8 × 409.
  - 5 simultaneous collections of one order deducted stock exactly once.
- The production Docker image runs as a non-root user. It refuses the development webhook secret and the development payment simulator.

**No Critical or High findings.** There are two **Medium** findings, both about how the local Docker setup exposes services on the network, plus several Low and documentation items. None block the required workflow.

---

## 2. Requirements compliance matrix

**Source of requirements.** The repository holds no assignment document (`git ls-files` shows only `README.md` as documentation). The requirements below come from:
- the *project-wide instructions*, and
- the per-phase briefs (Phases 1–6) supplied during development.

Any requirement in the original assignment that is not reflected in those cannot be assessed.

### Mandatory (from the project-wide instructions)

| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| TypeScript throughout | PASS | `backend/tsconfig.json`, `frontend/tsconfig.json` (strict); typecheck passes | — |
| Express + TypeScript backend | PASS | `backend/src/app.ts` | — |
| PostgreSQL via `pg`, parameterized SQL | PASS | All queries use `$n` placeholders. The only interpolation is the constant `LOCK_TIMEOUT` (`orders.service.ts:61,255`, `payments.service.ts:67`) and catalog-quoted table names in a test helper (`tests/helpers/testDatabase.ts:192`). | — |
| React + Vite + TypeScript frontend | PASS | `frontend/src/` | — |
| Vitest + Supertest against a real PostgreSQL database | PASS | `backend/vitest.config.ts`; 165 tests on `pickup_counter_test` | — |
| Docker + Docker Compose | PASS | `docker-compose.yml`; clean-start check in §6 | — |
| Zod validation | PASS | `src/schemas/*.ts`, `config/env.ts`, `middleware/validate.ts` | — |
| Money as integer paise, no float arithmetic | PASS | `INTEGER` columns (0002/0003/0004). Totals are summed as integers (`orders.service.ts`). The UI formats with integer division (`frontend/src/lib/format.ts`). | — |
| PostgreSQL is the source of truth for stock and order state | PASS | `product_availability` view (0003 L74–87); the frontend only displays server data (`App.test.tsx` "shows paid only after the server confirms it") | — |
| Transactions + row locking for concurrency-sensitive operations | PASS | `createOrder`, `processPaymentEvent`, `collectOrder` (§5) | — |
| Never trust frontend stock or client clocks | PASS | Prices and stock are read under lock on the server. Deadlines use `now()`/`clock_timestamp()`. The UI countdown is relative to the server's `expiresInSeconds` (`Countdown.tsx`). | — |
| Validate every incoming request | PASS | Every route with input has a Zod schema. Unknown fields are rejected (`.strict()`). The webhook is checked in the order signature → JSON → schema. | — |
| No secrets or stack traces exposed to customers | PASS | `errorHandler.ts:38–41`; tests: `errors.test.ts` "hides internal error details", `payments.test.ts` rollback test checks that internal error text never appears in responses | — |
| No mocked database for the three required concurrency tests | PASS / NOT VERIFIED | Real-DB concurrency tests exist: `orders.test.ts:495–520` (10 customers, 2 units), `payments.test.ts:486–502` (5 duplicate webhooks), `collection.test.ts:380–394` (2 simultaneous collects), plus others. | Which three tests the assignment requires is **not verifiable** without the original document. |
| `docker compose up --build` starts everything | PASS | §6 | — |
| No elaborate UI styling | PASS | Plain CSS (`frontend/src/styles.css`), no UI library | — |
| Never mark paid just because a webhook arrived | PASS | Signature, then schema, then order lock, then rules (`payments.service.ts`); 45 webhook tests | — |
| Documentation kept up to date | PARTIAL | `README.md` (644 lines) | Minor stale wording (F13) and a missing Node prerequisite (F14) |

### Phase deliverables

| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| `GET /health` returns 200 and checks the database | PASS | `health.test.ts`; 200 on dev, clean-start and prod-image stacks; 503 when the DB is stopped (*previously executed*, Phase 1) | — |
| Products schema with constraints, idempotent seed, `GET /products` | PASS | `0002_create_products.sql`; `products.test.ts`; clean start seeded 5 | — |
| Orders + order items with price snapshots | PASS | `0003_create_orders.sql`; `orders.test.ts` "keeps the original unit prices…" | — |
| 120-second reservation using database time; `expiresInSeconds` computed by the server | PASS | `orders.service.ts` (`now() + make_interval`), `:173`; test "sets a 120-second reservation…" | — |
| Availability = stock − active pending − paid uncollected | PASS | View 0003 L74–87; `orders.test.ts` "stock availability" block; `collection.test.ts` lifecycle test | — |
| Expired orders stop reserving immediately, without a worker | PASS | `orders.test.ts:313`; sweeper + read-time reconciliation only touch `pending` | — |
| `POST /orders`: validation, limits, duplicates, 409 / 422 | PASS | `orders.test.ts` validation and business-rule blocks | — |
| `GET /orders/:id`: effective status, 404 | PASS | `orders.test.ts` "GET /orders/:id" block | — |
| Signed webhook: HMAC-SHA256 over raw body, constant-time compare | PASS | `app.ts:22–23`, `signature.ts:12,28–35`; `payments.test.ts` signature block (including the raw-bytes test) | — |
| Durable idempotency (`UNIQUE event_id`, same transaction) | PASS | `0004…sql:27`; idempotency + concurrency tests | — |
| Late payment / amount mismatch → `needs_review`, no stock revival | PASS | `payments.test.ts` "payment decisions" block | — |
| Signed sender utility | PASS | `scripts/send-webhook.ts`; run in this audit (paid, then `duplicate:true`) | — |
| `POST /orders/:id/collect`: paid only, exactly-once deduction | PASS | `orders.service.ts:249–342`; `collection.test.ts` (19 tests); live 5-way race (§5) | — |
| Frontend: catalog, order, pay (dev), status, collect | PASS | `App.test.tsx` (28 tests); headless-Edge flow (§3) | — |
| Dev payment simulator off by default and impossible in production | PASS | `env.ts:23–36`; `devPayments.test.ts`; production image refuses it and the route returns 404 (§6) | Compose enables it for local dev (F2) |
| Webhook secret never reaches the browser | PASS | Fresh bundle scan: 0 hits; not in the frontend container environment; not `VITE_`-prefixed | — |
| `AI_NOTES.md` | NOT VERIFIED | File absent | Unknown whether the assignment requires it (F10) |

---

## 3. Test and build results (all run during this audit)

| Check | Result |
|---|---|
| Backend tests, dev stack (`docker compose exec backend npm test`) | **165 passed / 165**, 10 files, 76.5 s |
| Backend tests, clean-start stack | **165 passed / 165** |
| Frontend tests (`cd frontend && npm test`) | **46 passed / 46**, 2 files |
| Backend `typecheck` / `lint` / `build` | PASS / PASS / PASS |
| Frontend `typecheck` / `lint` / `build` | PASS / PASS / PASS |
| `git diff --check` | clean |
| Production image (`docker build --target prod`) | builds; runs as user `node`; applies migrations; `/health` 200 |
| Headless Edge, dev stack (port 5173) and clean stack (port 5174) | 390 px and 1280 px: no horizontal overflow; zero console errors, warnings or failed requests; reserve → pay → collect flow by clicking; reload keeps the order; Tab shows a 3 px focus outline |

**How good the tests are** (I inspected the assertions themselves):
- **Concurrency tests prove real overlap.** They hold a row lock from a separate connection, wait until `pg_stat_activity` shows all N requests blocked at once, then release. They then assert the database state (stock, reserved units, event counts, orphan rows), not just HTTP codes (`orders.test.ts:495–520`, `payments.test.ts:445–558`, `collection.test.ts:341–427`).
- **Test-database safety is enforced in layers:**
  - a config allow-list
  - a database-comment marker
  - a check of the live connection before destructive SQL
  - a session advisory lock for the whole run (`tests/helpers/testDatabase.ts`; 23 tests)
- **The tests catch real bugs (mutation checks).** In earlier phases (*previously executed*, not re-run in this audit):
  - moving the availability check before the lock produced 10 × 201 for 2 units
  - removing both the order lock and the status guard in collection deducted stock twice in 9 of 10 races
- **Gap:** the payment-vs-order-creation race at exactly 120 s is tested only indirectly, by proving the payment waits for the product locks (`payments.test.ts:547`). See F7.

---

## 4. Security findings

The intended deployment scope is a **local technical-assignment demo**, and severities reflect that.

| ID | Severity | Finding | Evidence | Impact | Recommended fix | Required for compliance? |
|---|---|---|---|---|---|---|
| F1 | **Medium** | Compose publishes PostgreSQL, the API and the frontend on **all network interfaces** | `docker-compose.yml:20,54,85` (`"${…_HOST_PORT}:…"` with no host IP); `docker compose ps` shows `0.0.0.0:` | Anyone on the same network can reach the database (documented dev password), the API, and, with F2, mark orders paid | Bind to loopback: `"127.0.0.1:${POSTGRES_HOST_PORT:-5433}:5432"`, and likewise for 4000 and 5173 | No (recommended) |
| F2 | **Medium** (Low on its own) | The dev payment simulator is **enabled by the Compose default** (`${DEV_PAYMENT_SIMULATOR:-true}`). The code default is `false`, and production refuses `true`. | `docker-compose.yml:49`, `.env.example:27`, `env.ts:23–36` | With F1, any LAN client can mark any known order paid | Fix F1 (removes the LAN exposure), **or** default to `false` and rely on the UI's fallback message | No |
| F3 | Low | `POST /orders/:id/collect` has no staff authentication or PIN | `routes/orders.routes.ts:11`; documented in the README and the UI | Anyone holding an order UUID can mark it collected and deduct stock. UUIDv4 IDs are unguessable, but anyone who sees an order ID (screen, shared link) can use it. | Out of scope unless the assignment requires auth; keep documented | No |
| F4 | Low | No CORS policy, and two state-changing POSTs take **no body**, which makes them CORS "simple requests": `/orders/:id/collect` and `/dev/orders/:id/simulate-payment` | `orders.routes.ts:11`, `dev.routes.ts:11` | A third-party web page open in the same browser could *blindly* trigger them against `localhost:4000` if it knew an order UUID. The response stays unreadable. | Require `Content-Type: application/json` (or a custom header) on these routes, so cross-site requests need a CORS preflight, which fails | No |
| F5 | Low | Unexpected 500s are logged in full (with stack) to server stdout | `errorHandler.ts:38` | Intended for operators. Responses stay generic (tested). PostgreSQL errors may include values such as an `event_id` in logs; no secrets are logged. | None needed | No |
| F6 | Info | No rate limiting on any endpoint | — | Out of scope for a local demo | — | No |

**Verified as correct:**
- **Webhook verification:**
  - the raw body is captured before the JSON parser (`app.ts:22–23`)
  - the header format and length are checked first, then `timingSafeEqual` compares (`signature.ts:12,28–35`)
  - missing, malformed or invalid signatures get 401 and change nothing (tested)
  - the secret must be at least 32 characters, and the `dev-only-` placeholder is refused in production (verified with the production image)
- **Secrets:** no `.env` file is tracked; `.env.example` contains placeholders only.

---

## 5. Concurrency and database findings

**Verified properties:**

| Property | Mechanism | Evidence |
|---|---|---|
| No overselling | `SELECT … FOR UPDATE` on products in id order, then availability recalculated in a new statement | `orders.test.ts:495–520`; **live:** 10 concurrent requests for 2 units gave 2 × 201 and 8 × 409, with stock 2 / reserved 2 / available 0 |
| No deadlocks between app paths | Every path locks the order row first (if it uses one), then products by id | multi-product tests in `orders.test.ts`, `collection.test.ts` |
| Expiry without a worker | `expires_at > now()` in the view; reconciliation only from `pending` | `orders.test.ts:313,387,400,424` |
| Payment decision serialised with order creation | Payment locks the order row, then the products, then decides with `clock_timestamp()` | `payments.service.ts:91,105`; `payments.test.ts:547` |
| Exactly-once payment | `UNIQUE(event_id)` (0004 L27) + order lock + guarded `UPDATE … WHERE status='pending'` | `payments.test.ts:445–558`; live sender `--repeat 2` gave `duplicate:true` |
| Exactly-once collection, no negative stock | Order lock; guarded deduction `stock_quantity >= quantity` (`orders.service.ts:312`); guarded `status='paid'` update (`:322`); `CHECK stock_quantity >= 0` | `collection.test.ts`; **live:** 5 concurrent collects gave 1 × `false` and 4 × `true`; stock 37 → 34 for 3 units |
| Atomic rollback | Single transaction per operation; failure tests use a temporary trigger | `payments.test.ts` and `collection.test.ts` rollback tests |

**Findings:**

| ID | Severity | Finding | Evidence | Impact | Recommended fix | Required? |
|---|---|---|---|---|---|---|
| F7 | Low | The 120 s payment vs. order-creation boundary is tested only indirectly | `payments.test.ts:547` proves the payment waits for the product locks; the boundary decision itself relies on the design argument in `payments.service.ts` | A regression that removed the product-lock step would only be caught by that lock-wait test | Optional: add a deterministic test (order expiring in about 1 s while a competing order holds the product lock) | No |
| F8 | Low | PostgreSQL deadlock (`40P01`) is not mapped and would return a generic 500. Only lock timeouts (`55P03`) map to 503. | `orders.service.ts:136,331`, `payments.service.ts:162` | The app's own lock ordering prevents deadlocks. Two sweeper instances could deadlock each other, which can't happen with one API process. | Optional: map `40P01` to 503 "retry" | No |
| F9 | Low (*inferred*) | Countdown boundary burst: in the final second the server can report `pending` with `expiresInSeconds: 0` (floored). The countdown then re-fetches after each response until the server reports `expired`. | `orders.service.ts:173`, `Countdown.tsx:30–32` | A short burst of sequential GETs, under 1 s. Never overlapping (forced refresh aborts the previous request). Not observed directly. | Optional: skip the countdown re-fetch when `expiresInSeconds === 0`, or add a minimum interval | No |

---

## 6. Docker and deployment findings

**Clean start (verified).** I ran `docker compose -p pickup-audit up --build -d` with host ports 5434, 4001 and 5174, on a **separate volume** (`pickup-audit_pgdata`). The development volume `pickup-counter_pgdata` was never touched.

| Check | Result |
|---|---|
| Fresh database initialisation | `pickup_counter` and `pickup_counter_test` created; the test DB has the marker comment |
| Migrations | 0001–0004 applied on startup |
| Seed | 5 products |
| Readiness / health checks | db, then backend, then frontend became healthy in order; ready after 58 s |
| Endpoints | `/health`, `/api/health`, `:5174/api/health`, `/products`, `:5174/` all 200 |
| Service networking | backend → `db:5432`, frontend proxy → `backend:4000` (proxied API calls succeeded) |
| Restart | `restart backend`: SIGTERM, "Shutdown complete.", healthy again; migrations "up to date"; seed inserted 0 |
| Persistence | `down` (volume kept) then `up`: orders 5 → 5 |
| Teardown | `docker compose -p pickup-audit down -v` removed only `pickup-audit_*` |
| Production image | builds; user `node`; refuses the dev secret and `DEV_PAYMENT_SIMULATOR=true`; simulator route returns 404 |

**Findings:**
- **F1/F2** (above): ports bound to all interfaces, and the simulator on by default in Compose.
- **F11 (Info):** the frontend container runs the **Vite dev server** (`frontend/Dockerfile:8`); Compose uses the backend `dev` target (`docker-compose.yml:38`). That suits a local assignment. A production deployment would need to serve `frontend/dist` statically, which is not part of the documented scope.
- **F12 (Info, environment-specific, not a repository defect):** on the audit machine, a separately installed PostgreSQL also listens on host port **5433**, so host-side tools reached that server instead of the Compose database. Everything run *inside* Docker is unaffected. The README documents the `POSTGRES_HOST_PORT` override.

---

## 7. Documentation gaps

| ID | Severity | Gap | Evidence | Fix |
|---|---|---|---|---|
| F13 | Low | Stale wording in the status table: "Order creation (this phase)", "Expiry (this phase)", "Payment (Phase 4)" | `README.md:409–412` | Replace with the endpoint names, as the `collected` row already does |
| F14 | Low | Prerequisites list only Docker Desktop. Host-side commands (`cd frontend && npm test`, the webhook sender from the host, backend `typecheck`) need **Node.js ≥ 22** and `npm install` | `README.md:25`; `backend/package.json` `engines` | Add Node.js ≥ 22 + `npm ci` for host-side commands |
| F10 | Info → **decision needed** | No `AI_NOTES.md`, and no assignment document, in the repository | `git ls-files` | If the assignment requires AI notes, the content must come from the author's actual usage; it cannot be generated from this audit |

The rest of the README is accurate against the code: architecture, environment variables, migrations and seeding, endpoints, payment simulation, reservation and inventory rules, tests, test-database safety, and limitations. I spot-checked it against routes, schemas and Compose.

---

## Fix status (follow-up, 2026-10-24)

The approved fixes were applied on top of `f118639`. They are **uncommitted**. Every result below comes from a command run after the change.

| Finding | Change | Verification |
|---|---|---|
| F1 / F2 | `docker-compose.yml`: all published ports bound to `127.0.0.1`; the simulator stays on for local dev but is now reachable only from this machine | `docker compose ps` shows `127.0.0.1:` mappings; `netstat` listens on `127.0.0.1` only; the LAN address `192.168.1.46` refuses 4000, 5173 and the database port; `localhost` URLs return 200 |
| F13 / F14 | README: status table names the real triggers; prerequisites add Node.js ≥ 22 + `npm ci` for host-side commands; documents loopback binding, the 415 contract, and the port-conflict behaviour | Reviewed |
| F4 | New `middleware/requireJson.ts`, mounted on `POST /orders/:id/collect` and `POST /dev/orders/:id/simulate-payment`: anything but `application/json` gets **415** `UNSUPPORTED_MEDIA_TYPE`. The frontend now sends `{}`. Body validation, `POST /orders` and the webhook are unchanged. | `tests/contentType.test.ts` (21 tests: 5 rejected types × 2 routes leave state unchanged, 4 accepted forms × 2 routes, body still validated, cross-origin preflight not granted); curl through the proxy gives 415 / 200 |
| F9 | `Countdown.tsx`: re-check only when the local countdown ran down from a positive value. Also fixed a related display bug found while testing: right after a fresh response the countdown could show one extra second, because elapsed time briefly went negative; it is now clamped at zero. | New frontend regression test; it fails ("expected 3 to be 2") when the guard is removed |
| F8 | `db/transaction.ts`: `isLockContention()` covers `55P03` and `40P01`; the three existing catch blocks map both to the existing 503 `*_BUSY` errors. No automatic retry; the transaction is already fully rolled back. | New real-PostgreSQL deadlock test in `orders.test.ts`; it fails (500) when `40P01` is removed from the mapping |

**Results after the fixes:**
- **Backend:** 187/187, both in Docker and from the Windows host (the latter now possible because of the loopback binding).
- **Frontend:** 47/47.
- Typecheck, lint and build pass for both; `git diff --check` is clean.
- The full reserve → pay → collect flow passed through the API proxy and in headless Edge, with zero console errors.

**New environment finding (F15, this machine only).** A separately installed PostgreSQL listens on `0.0.0.0:5433` here. Windows refuses Docker's `127.0.0.1:5433` bind while that wildcard listener exists, so with the repository default `docker compose up` **fails to start `db`** on this machine. Previously the two coexisted silently, and host access reached the wrong server.
- Workaround used for verification: `POSTGRES_HOST_PORT=5434 docker compose up -d`.
- Persistent options: a local, git-ignored `.env` with `POSTGRES_HOST_PORT=5434`, stopping the other PostgreSQL, or changing the repository default.
- Machines without that conflict are unaffected.

## 8. Prioritised fixes (P1, P2 and F8 applied; see "Fix status")

| Priority | Fix | Findings | Size | Changes business logic? |
|---|---|---|---|---|
| P1 | Bind published ports to `127.0.0.1` in `docker-compose.yml` | F1 (and most of F2) | 3 lines | No |
| P1 | README: fix stale status-table wording; add the Node ≥ 22 prerequisite for host-side commands | F13, F14 | Docs only | No |
| P1 | Decide on `AI_NOTES.md` (author input required) | F10 | Docs only | No |
| P2 | Require `Content-Type: application/json` on body-less state-changing POSTs (collect, simulate) | F4 | Small; frontend `apiPost` would send `{}` | No (request contract only) |
| P2 | Countdown: don't re-fetch on a zero-second server value | F9 | Small (frontend) | No |
| P3 | Map `40P01` to 503; add a deterministic boundary-race test | F8, F7 | Small | No |
| — | Default `DEV_PAYMENT_SIMULATOR` to `false` in Compose | F2 | 2 lines + docs | No (but the UI payment button would need an opt-in) |

---

## 9. Known limitations (by design, documented)

- **No staff authentication or pickup PIN** (F3). The UI says so.
- **Payment simulation is development-only.** Real payments come through the signed webhook (`npm run webhook:send`). No refunds are implemented; `late_payment`, `amount_mismatch` and `already_paid` events are left for staff to resolve.
- **`needs_review` holds no stock.** An amount mismatch releases the reservation immediately.
- **Webhook signatures carry no timestamp.** Replays are harmless because the same `eventId` is never applied twice.
- **The catalog doesn't refresh on a timer.** It updates after the user's own actions and status changes, or when Refresh is pressed.
- **One expiry sweeper per API process.** It's correct without the sweeper; the sweeper only tidies the stored status.
- **Browser verification used headless Edge only.** Other browsers and real mobile devices were not tested.

---

## Brief compliance follow-up (2026-10-24)

The employer brief was supplied after this audit. Checking against it found three gaps, now closed (uncommitted):

| Brief requirement | Gap found | Resolution |
| --- | --- | --- |
| `POST /orders/:id/pickup-claim`, with exactly one simultaneous success and **409** for the competing claim | Route absent; `/collect` returned 200 `alreadyCollected: true` to the loser | Added `pickup-claim` (same exactly-once `collectOrder` service, 409 `ORDER_ALREADY_COLLECTED` for the competing or repeated claim). `/collect` kept unchanged as an idempotent variant. The frontend uses `pickup-claim`. |
| Three real-PostgreSQL concurrency tests | The webhook test sent 5 copies, not the brief's "twice"; no pickup-claim race test | Added "the same webhook event delivered twice simultaneously is applied exactly once" and "two simultaneous pickup claims: exactly one succeeds, the other gets 409". The 10-customer test already existed. |
| `AI_NOTES.md` | Missing (F10) | Added, using the tools the author confirmed and a real AI error from this project (the port-binding change) |

The local port conflict (F15) is resolved on this machine with a git-ignored `.env` (`POSTGRES_HOST_PORT=5434`). The repository default stays at 5433.

## 10. Submission readiness verdict

**READY WITH LIMITATIONS**, against the requirements available in this repository and session:
- Every mandatory requirement listed in §2 is satisfied, with test, command or live-run evidence.
- There are no Critical or High findings.
- The two Medium findings (F1, F2) concern the local Docker network exposure and have 3-line fixes.

**Not verifiable:**
- Compliance with the **original assignment document**, which is not in the repository. This includes any mandatory deliverable it may define, such as `AI_NOTES.md`, a specific set of three concurrency tests, or required endpoints or UI flows beyond those implemented.
- Until that document is checked, overall compliance with the original specification remains **UNVERIFIED**.

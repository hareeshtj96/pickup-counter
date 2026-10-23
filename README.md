# Pickup Counter

A full-stack TypeScript application for ordering items for counter pickup.

| Layer    | Technology                                     |
| -------- | ---------------------------------------------- |
| Backend  | Node.js 22, Express 5, TypeScript (strict), Zod |
| Database | PostgreSQL 16 via `pg` (parameterized SQL only) |
| Frontend | React 19, Vite 6, TypeScript (strict)          |
| Tests    | Vitest + Supertest against a real PostgreSQL DB |
| Runtime  | Docker + Docker Compose                        |

**Status:** Phase 1 (foundation) is complete. Products, orders, payments and pickup are not built yet.

---

## Quick start

Prerequisite: Docker Desktop is running.

```bash
docker compose up --build
```

| Service  | URL                                  |
| -------- | ------------------------------------ |
| Frontend | http://localhost:5173                |
| API      | http://localhost:4000/health         |
| Postgres | `localhost:5433` (user `pickup`, db `pickup_counter`) |

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
docker compose exec backend npm test           # integration tests on pickup_counter_test
```

Open http://localhost:5173. The page should show **API: ok · Database: up**.

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
2. `backend` waits for `db` to be **healthy**, applies pending migrations, then starts the API. Its health check calls `GET /health`, which runs `SELECT 1`.
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
    db/seed.ts             Seed data (empty until Phase 2)
    db/cli/                `npm run migrate` / `npm run seed` entry points
    routes/                URL -> controller wiring
    controllers/           HTTP layer: read request, call service, send response
    services/              Business logic and SQL
    middleware/            validate (Zod), notFound, errorHandler
    errors/AppError.ts     Errors that are safe to show to clients
  tests/                   Vitest + Supertest integration tests
```

Request flow: `route → validate middleware → controller → service → PostgreSQL`. Errors go to `errorHandler`.

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

| Frontend            | Purpose                       |
| ------------------- | ----------------------------- |
| `npm run dev`       | Vite dev server on :5173      |
| `npm run build`     | Typecheck + production build  |
| `npm run typecheck` | `tsc --noEmit`                |
| `npm run lint`      | ESLint                        |

### Tests

Tests use a **real PostgreSQL database** named `pickup_counter_test`. It is created automatically the first time the `db` volume is initialised (`docker/postgres/init/01-create-test-db.sql`). The test config refuses to run unless the database name ends in `_test`, so tests can never wipe development data.

```bash
# Inside Docker (TEST_DATABASE_URL is already set):
docker compose exec backend npm test

# From your machine:
TEST_DATABASE_URL=postgres://pickup:pickup_dev_password@localhost:5433/pickup_counter_test npm test
```

> If your `db` volume was created before the init script existed, create the test DB once:
> `docker compose exec db psql -U pickup -d pickup_counter -c "CREATE DATABASE pickup_counter_test;"`

---

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

## Security notes

- `.env` is gitignored. `.env.example` contains placeholders only.
- All SQL uses parameter placeholders (`$1`, `$2`, ...). User input is never concatenated into SQL.
- Env validation errors print variable names only, never values.
- `x-powered-by` is disabled; JSON bodies are limited to 100 kB.

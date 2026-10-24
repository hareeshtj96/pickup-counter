# AI Notes

How AI tools were used to build Pickup Counter, what worked, and where the AI got something wrong.

## Tools used

| Tool | What it helped with |
| --- | --- |
| **Claude Code** (Anthropic), in VS Code | Implemented each phase in this repository: the Express/TypeScript backend, SQL migrations, the order/payment/pickup services, the React frontend, Docker Compose, and the Vitest/Supertest test suites. It debugged failures, ran the verification commands (tests, typecheck, lint, builds, Docker health checks, real-browser checks with headless Edge), ran mutation checks to confirm key tests catch real bugs, and produced the final audit (`docs/FINAL_AUDIT.md`). |
| **ChatGPT** (OpenAI) | Helped draft and refine the phase-by-phase prompts given to Claude Code, review its reports, and discuss design decisions. |

## How the work was organised, and what the author verified

- **Phases with explicit acceptance criteria.** The project was built in phases: foundation, catalog, reservations, test-database safety, payment webhook, pickup, frontend, final audit, audit fixes, and brief compliance. Most phase prompts stated acceptance criteria and required that no check be reported as passing unless it had actually been run.
- **Plan before code, where it mattered.** For several phases (the foundation, pickup collection, the audit fixes, and brief compliance), Claude Code presented a plan for approval before changing code. Where a decision was genuinely the author's, Claude Code asked rather than assumed.
- **The author made the product decisions**, including:
  - whether a repeated pickup should return 200 or 409 (first 200; later `pickup-claim` with 409, to match the requirement given to the author)
  - keeping the default PostgreSQL host port at 5433
  - how to resolve the local port conflict
  - which AI error to document here
- **Commits at milestones, made by the author.** The work was developed and reviewed in phases, and the author committed at milestones.
  - As of commit `bc89333` ("Feat: Project final tests done"), the history has seven commits, from "Initialised Project Foundation" (`756d3f5`) to `bc89333`. All seven are authored by the author, and none contains an AI co-author line.
  - The catalog phase and the test-database hardening share one commit (`ff4e7d0`).
  - `bc89333` contains, together: these notes, `docs/FINAL_AUDIT.md`, the `pickup-claim` route and controller, the JSON content-type middleware and its tests, the Docker Compose port-binding change, and the README changes of that time.
  - Work made after `bc89333` is not covered by this description: the webhook header and signature-format alignment, the expired-order `pickup-claim` tests, and the documentation restructure (`docs/TECHNICAL_DETAILS.md`, `docs/TESTING.md`) and corrections. Check `git log` for how those were committed.
  - Claude Code did not commit or push.
- **Claims were backed by evidence.**
  - Reported test and build results came from commands that were actually executed. Anything the audit could not execute is labelled as inferred or historical.
  - The concurrency tests prove real overlap: `pg_stat_activity` shows every request blocked at once.
  - Mutation checks (temporarily removing a safeguard, then restoring the file) confirmed that the key tests fail without the locking and status guards.

## A prompt that worked well

The Phase 2.1 prompt on test-database safety. Below is a verbatim excerpt from section 1 of that prompt, as given to Claude Code. The list of files to review that preceded it, and the rest of the prompt, are omitted.

> The current test guard checks only whether the database name ends in `_test`, while `globalSetup.ts` drops and recreates the public schema.
>
> Implement defense in depth:
> - Require an explicitly configured test database.
> - Validate the expected database name, host and port against the actual project configuration.
> - Require an explicit marker proving the database is designated for tests.
> - Verify the actual connection's database identity before executing destructive SQL.
> - Fail closed if any safety check fails.
> - Never automatically fall back to `DATABASE_URL` for destructive test setup.
> - Never drop schemas or reset data on an unverified database.
> - Keep the development database separate and untouched.

**Why it worked:**
- It named the concrete risk (a schema drop guarded only by a name suffix) and listed testable properties instead of a vague "make tests safer".
- The result was a layered guard: a config allow-list, a database-comment marker, an identity check on the live connection, and an advisory lock held for the whole test run.
- Each layer got its own tests. The guard was then demonstrated by running the suite against an *unmarked* test database: it refused, and the schema was left untouched.

## An AI error and how it was caught

**What happened.**
- The final audit (`docs/FINAL_AUDIT.md`, finding F1) noted that Docker Compose published PostgreSQL, the API and the frontend on all network interfaces.
- Claude Code recommended binding them to `127.0.0.1`, and implemented it after the author approved.
- Claude Code had already seen, in earlier phases, that another PostgreSQL on this machine used port 5433. It did not anticipate that the new binding would stop the Compose database from starting there.
- The problem was limited to this machine and to startup. No data was lost, and the stack was restored the same session.

**What was directly observed (error output).** The verification step Claude Code ran after the change, `docker compose up --build -d`, failed with:

```
Error response from daemon: ports are not available: exposing port TCP 127.0.0.1:5433 -> 127.0.0.1:0: listen tcp4 127.0.0.1:5433: bind: An attempt was made to access a socket in a way forbidden by its access permissions.
```

`docker compose ps` then showed no running services: the containers were recreated, but the database did not start.

**What the port and process checks confirmed.**
- `netstat -ano` showed process 7716 listening on `0.0.0.0:5433` and `[::]:5433`, and `Get-Process` reported that process as `postgres`. This is a PostgreSQL installation outside Docker.
- In an earlier phase, the same checks had shown that process and Docker's port forwarder *both* listening on `0.0.0.0:5433`. Host connections to `127.0.0.1:5433` were then rejected with `28P01` by a server that was not the Compose database.

**What was inferred (not separately proven).** Windows refused Docker's `127.0.0.1:5433` bind *because* another process already held a wildcard (`0.0.0.0`) listener on the same port. This fits all of the observations, and the same binding succeeded on the free port 5434, but the operating-system behaviour itself was not tested in isolation.

**How it was resolved.**
- Claude Code brought the stack back with a one-off `POSTGRES_HOST_PORT=5434 docker compose up -d`, then reported the problem and the options.
- The author chose a permanent, machine-specific fix: a git-ignored root `.env` containing `POSTGRES_HOST_PORT=5434`.
- The repository default stayed at 5433, the loopback-only binding was kept, and the other PostgreSQL was left untouched.
- Re-verification, with the results at the time:
  - the normal `docker compose up -d` started all services healthy, with the database on `127.0.0.1:5434`
  - the existing development data was intact
  - the machine's LAN address refused all three ports
  - the backend suite passed from the host against port 5434

**Lesson.** A security-motivated configuration change can have side effects that depend on the machine. It needs a real startup check on the target machine before it counts as done; here, that check is what caught the problem.

## Limitations of these notes

- They describe the AI-assisted work in the Claude Code sessions for this repository and the tools the author confirmed. They are not a complete log of every prompt.
- Test counts and results quoted here and elsewhere (README, `docs/FINAL_AUDIT.md`) are historical: they come from commands run at the time. Re-run the commands in the README to reproduce them.
- ChatGPT's role is described as confirmed by the author; its conversations are not part of this repository.

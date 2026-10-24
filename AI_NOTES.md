# AI Notes

## AI tools used

- **Claude Code** (Anthropic, in VS Code): wrote the backend, frontend, migrations and Docker setup, wrote and ran the tests, debugged failures, and verified the results.
- **ChatGPT** (OpenAI): helped draft and refine the prompts given to Claude Code, review its reports, and discuss design decisions.

## A prompt that worked well

The test-database safety prompt (excerpt):

> The current test guard checks only whether the database name ends in `_test`, while `globalSetup.ts` drops and recreates the public schema.
>
> Implement defense in depth: […]
> - Require an explicit marker proving the database is designated for tests.
> - Verify the actual connection's database identity before executing destructive SQL.
> - Fail closed if any safety check fails.

It worked because it named one concrete risk (a schema drop guarded only by a name suffix) and listed checks that could each be tested. The result was a layered guard: an allow-list for the name, host and port, a marker comment on the database, an identity check on the live connection, and a lock that stops two test runs overlapping. Running the suite against an unmarked test database was refused before anything was dropped.

## A mistake the AI made

To stop Docker publishing the database, API and frontend to the whole network, Claude Code changed Compose to bind the ports to `127.0.0.1`. It had already seen another PostgreSQL on this machine using port 5433, but did not foresee the effect: `docker compose up` stopped starting the database, with

```
ports are not available: exposing port TCP 127.0.0.1:5433 … bind: An attempt was made to access a socket in a way forbidden by its access permissions
```

The re-run of the startup check exposed it. `netstat -ano` showed a process listening on `0.0.0.0:5433`, and PowerShell's `Get-Process` identified it as `postgres`, a PostgreSQL installed outside Docker. The likely cause is that Windows will not let a second program bind that port on `127.0.0.1` while another already holds it on all addresses. That explanation is an inference; it fits the evidence but was not tested separately.

I fixed it without touching that PostgreSQL or the repository default: a Git-ignored `.env` containing `POSTGRES_HOST_PORT=5434` moves only this machine's database port. The stack then started normally and the existing data was intact.

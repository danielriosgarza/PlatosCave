# Operations runbook

How to run Parallax in production (spec §13, §14, §17). The deployment is `infra/compose.prod.yml`; this page says what to put in it, what to watch, and what to do when it is red. Backups have their own page: [backup-restore.md](backup-restore.md). The runner's host and network rules are in [design/runner.md](design/runner.md) §10; the connector's in [design/connector.md](design/connector.md) §12.

## Topology

| Service | Runs | Reaches | Holds |
| --- | --- | --- | --- |
| `api` | `apps/server` in `api` mode: the HTTP API and the web app | Postgres, Garage, mail | `SESSION_SECRET`, `CONTENT_TOKEN_SECRET`, storage keys, `SMTP_URL` |
| `relay` | `apps/server` in `relay` mode: everything `api` serves, plus the connector link and the notebook-session routes | as `api` | as `api` |
| `worker` | background jobs: ingestion, mapping, retention, grading results | as `api` | as `api` |
| `runner` | sandbox containers, through the host's Docker daemon | Postgres as `parallax_runner` only | `RUNNER_DATABASE_URL`; the Docker socket; **no application secret** |
| `postgres`, `garage` | the database and the object store | each other's clients only | the data |
| `connector-managed` (optional) | the managed connector (`--profile managed`) | the relay's public URL and the hosts it pins | its own identity key |

Networks (`infra/compose.prod.yml`, held by `apps/server/src/infra/compose-prod.test.ts`): `backend` (internal) joins Postgres, Garage, api, relay and worker; `egress` gives api, relay and worker the route to the mail server and the published ports; `runner-db` (internal) joins Postgres and the runner and nothing else; `managed` holds the managed connector, which has no route to Postgres or Garage. Sandbox containers have no network at all. Run **exactly one** `relay`: connector links live in its memory.

For a real deployment give the runner its own host (design §10.1): the socket it holds is root-equivalent there. The compose file keeps it apart in network and in what it can read, not in machine.

## First start

1. **Host.** Docker with Compose v2; for sandboxes, gVisor (`runsc`) registered as a Docker runtime (`RUNNER_DOCKER_RUNTIME`, default `runsc`). Note the group id of `/var/run/docker.sock` (`stat -c %g /var/run/docker.sock`) for `DOCKER_GID`.
2. **Environment file** `prod.env` (never committed; mode 0600). Required, no defaults: `POSTGRES_PASSWORD` and `RUNNER_DB_PASSWORD` (both go into connection URLs, so generate them URL-safe: `openssl rand -hex 32`; base64 output contains `/`, `+` and `=`), `APP_ORIGIN`, `APP_HOST`, `CONTENT_ORIGIN`, `CONTENT_HOST` (two host names, ADR-0002), `SESSION_SECRET` and `CONTENT_TOKEN_SECRET` (32 or more random characters each: `openssl rand -base64 48`), `TRUST_PROXY`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `SMTP_URL`, `MAIL_FROM`, `GARAGE_CONFIG`, `DOCKER_GID`, `RUNNER_RUNTIMES`, `RUNNER_IMAGES`. `docker compose config` names the first one still missing. Set `INSTRUCTOR_EMAILS`, `RETENTION_DEACTIVATED_GRACE_DAYS` and `RETENTION_AUDIT_DAYS` before the first class (spec §13: retention is decided before production; each rule is off while unset).
3. **Garage.** Write your own `garage.toml` (the file in `infra/garage` carries a published development secret) and point `GARAGE_CONFIG` at it. Start `garage`, assign its layout, create the bucket `S3_BUCKET` and an access key with read and write on it, as `scripts/garage-init.sh` does for development; put the key in `prod.env`.
4. **Runtimes and images.** `RUNNER_RUNTIMES` (server) and `RUNNER_IMAGES` (runner) are two views of one decision and change together. Both list **every** runtime the course may select, today `python-3.12` and `r-4.6`, each pinned by digest: a runtime missing from `RUNNER_IMAGES` makes every run of it end `image_not_allowed`, and production refuses a runtime without a digest. Keep the previous digest in `RUNNER_IMAGES` after an update, so replays still find it (design §10.4). Pull the images on the runner's host first: `RUNNER_PULL` is `never`.
   ```
   RUNNER_RUNTIMES=[{"id":"python-3.12","language":"python","image":"registry.example.org/parallax-runner-python","digest":"sha256:…","harnessVersion":"4","packages":["numpy","pandas","scipy"]},{"id":"r-4.6","language":"r","image":"registry.example.org/parallax-runner-r","digest":"sha256:…","harnessVersion":"4","packages":["jsonlite"]}]
   RUNNER_IMAGES={"python-3.12":["registry.example.org/parallax-runner-python@sha256:…"],"r-4.6":["registry.example.org/parallax-runner-r@sha256:…"]}
   ```
5. **Start.** `docker compose --env-file prod.env -f infra/compose.prod.yml up -d --build postgres garage`, then the rest. `migrate` applies the schema and exits; api, relay and worker wait for it. The first migration creates the role `parallax_runner` when the connecting role may create roles (here it does); give it its password and login once: `ALTER ROLE parallax_runner LOGIN PASSWORD '<RUNNER_DB_PASSWORD>' CONNECTION LIMIT <slots + 4>;`, then `docker compose … restart runner`. A deployment that migrates with a less privileged role runs `scripts/runner-role.sql` first (design §10.3).
6. **Verify** (§Readiness): `curl -fsS -H "Host: $APP_HOST" http://127.0.0.1:3000/api/ready` answers 200 with every check `ok`. Then run the sample job of design §10.4 through the real path.

## Routing

The reverse proxy owns TLS and routes by host and path. It must forward `Host` unchanged: the app and content origins are told apart by the raw `Host` (ADR-0002), and the app answers 404 on any other.

| Host | Path | To |
| --- | --- | --- |
| `APP_HOST` | Every route that reads or closes a live connector link: the connector API `/api/connector/v1/…` (including the link's WebSocket), the device list and its actions `/api/me/connectors…`, account closure `/api/me/deactivate` and `/api/me/delete`, and the notebook-session routes `/api/classes/*/notebook-sessions…` and `/api/me/connections/*/test…` (including their WebSockets) | `relay` (`127.0.0.1:${RELAY_PORT:-3001}`) |
| `APP_HOST` | everything else | `api` (`127.0.0.1:${API_PORT:-3000}`); the relay serves the same, so a small deployment may send every path to the relay |
| `CONTENT_HOST` | everything | `api`; it answers only `/content/<token>` |

Links live only in the relay's memory (design §10.1), so a device's `online` and Test connection are true only where the relay answers; the `api` reads every connector as offline. A revocation committed by any process (revoke, unpair or account closure) is announced on the Postgres channel `parallax_connector_revoked`, and the relay closes that link at once with 4403 `revoked`; if the relay's listening connection drops, it reconnects within 5 seconds and re-reads every live link's row, and each link still re-reads its row every 60 seconds.

Allow WebSocket upgrades and an idle timeout of at least 60 seconds on the relay's paths (links ping every 15 seconds). Set `TRUST_PROXY` to the proxy's address or CIDR range: `req.ip` keys the per-address limits and the logs, and without it every client shares the proxy's address. A proxy that appends to `X-Forwarded-For` (nginx's default) must be named by address, not by `true` (`apps/server/src/config.ts`).

## Readiness and health

| Probe | Path | Answers | Use |
| --- | --- | --- | --- |
| Liveness | `GET /api/health` | 200 while the process serves; carries `db: ok | unavailable | skipped` | restart a hung process |
| Readiness | `GET /api/ready` | 200 `ready`, or 503 `not_ready`, with the same body | take an instance out of rotation; the compose health check |

The readiness body lists each dependency with `status` (`ok`, `unavailable`, `skipped`), `required`, and `latencyMs`; it never carries an error message, host or credential (the cause is in the log as `readiness: dependency unavailable`, field `dependency`).

| Check | Required | `unavailable` or `skipped` means |
| --- | --- | --- |
| `database` | yes | Postgres does not answer `select 1` within 5 s, or the process has no `DATABASE_URL` |
| `queue` | yes | pg-boss did not start against the database (`pg-boss error` in the log); jobs cannot be queued. The queue is started once, when the process starts: if Postgres was unreachable then, the check stays `skipped` after the database recovers until api and relay are restarted |
| `executionQueue` | no | the runner's queue (`pgboss_exec`) did not start: code runs answer 503, everything else works |
| `storage` | yes | the object store is unusable within 5 s: the bucket does not exist or answers an error (S3 `HeadBucket`, which needs the `s3:ListBucket` permission beside Get, Put and Delete of objects), or the storage directory cannot be written |

`/api/ready` runs a database query and a storage call on every request and names the failing dependency: use it from the compose health check and the proxy's own probe, and do not route it to the public host (answer 404 for it there). The worker and the runner serve no HTTP. The worker logs `worker started` with its job names, and exits non-zero when it cannot start; the runner's health is the queue: see §Incidents. Watch, per design §10.4, the depth of `execution.run` and the age of its oldest `created` job.

## Logs

Every process writes one JSON object per line to stdout (pino); compose rotates them (20 MB × 5). Request lines carry `method`, the redacted `url`, `host`, `remoteAddress` and `statusCode`; job and relay lines carry ids, states and error codes. **They never carry private content or credentials** (spec §13; the one exception known is Fastify's own log of a 4xx for a malformed JSON body, whose parser message can quote a fragment of that body): `apps/server/src/logging.ts` removes, at the top level and one level down, the keys `body`, `payload`, `content`, `text`, `files`, `answers`, `source`, `stdin`, `stdout`, `stderr`, `email`, `address`, `recipient`, `to`, `headers`, `cookie`, `authorization`, `token`, `password`, `secret`, `nonce` and the connection strings, from request and response headers too; `?token=` and any path segment that could be a token are replaced in URLs; and pg-boss warnings are logged as their message and elapsed seconds only (a slow-query warning carries the SQL and the bound job data); error lines, and each member of an `AggregateError`, drop what database errors copy from their input (`detail`, `where`, `params`, `parameters`, the failing query): an error raised by a query, including drizzle's `DrizzleQueryError`, is logged as `database query failed (<SQLSTATE>)` with no SQL, bound values or stack, because its message, stack and causes all quote them. `logging.test.ts` makes real requests carrying sentinel secrets, and throws a real `DrizzleQueryError`, and fails if a sentinel reaches a log line of the API or the worker. The runner redacts by the same rule with its own list (`apps/runner/src/log.test.ts`).

Rules for new log calls: log ids, counts and codes, never a request, a result or a user's text; do not add a key to the list to make a log call convenient. Keep `LOG_LEVEL=info`; `debug` adds scope-denial lines and is for short investigations. Ship the logs off the host and keep them for the audit period the organisation chose; they are operational records, not the audit trail (that is the `audit_events` table, retention `RETENTION_AUDIT_DAYS`).

## Rate limits

| What | Limit | Counted per | Setting |
| --- | --- | --- | --- |
| Sign-in link requests | 120 / 15 min (and 5 unused links per address, then one a minute) | client address | `AUTH_LINK_RATE_LIMIT` |
| Sign-in link use | 240 / 15 min | client address | `AUTH_VERIFY_RATE_LIMIT` |
| Joining a class, accepting an invitation | 20 / 15 min | session | fixed |
| **Code-run requests** (sample runs, replays, instructor previews, all three together) | 30 / min | **session** | `RUN_RATE_LIMIT` |
| Queued or running sample runs per student | 2, across classes | student | fixed (spec §11) |
| Connector pairing: codes created, failed pairings, polls | 5 / hour per person; 10 failures in 10 min block an address for 10 min; 1 poll / s | person, address, connector | fixed (connector design §3) |
| Connector link attempts | 30 / min | address | fixed |
| Notebook browser channel messages, kernel executes | 60 / s, 30 / s | session | fixed |

Execution limits are counted per session so a class behind one campus network, or the load test's single client, does not share a budget; the sign-in limits are per address because no session exists yet. Over a limit the API answers `429` with `error: "too many requests"` and `Try again in …`. Limits are in memory: they reset when a process restarts and are per process, so a second `api` replica doubles them.

## Configuration

Defaults an operator may change, all in the environment (`apps/server/src/config.ts` documents each; every value is validated at start-up and a bad one stops the process):

| Variable | Default | Meaning |
| --- | --- | --- |
| `SESSION_TTL_DAYS` | 14 (1–90) | how long a sign-in lasts; cookie and stored expiry agree, including the instructor session kept and restored around a draft preview. Shortening it does not end sessions already issued |
| `LEASE_IDLE_MINUTES` | 30 (5–240) | an open notebook with no activity stops after this long |
| `LEASE_GRACE_MINUTES` | 5 (1–60) | closing the tab keeps the kernel this long. Both lease values apply when a request names no lease and the class template sets none; the web Connect panel pre-fills them |
| `RUN_RATE_LIMIT` | 30 | code-run requests per session per minute |
| `AUTH_LINK_RATE_LIMIT`, `AUTH_VERIFY_RATE_LIMIT` | 120, 240 | sign-in limits per address per 15 minutes |
| `RUNNER_SLOTS` | 4 (1–32) | concurrent sandbox containers (runner) |
| `RETENTION_DEACTIVATED_GRACE_DAYS`, `RETENTION_AUDIT_DAYS` | unset (off) | retention policy (spec §13). The audit sweep keeps two kinds of event the product reads as state, whatever their age: the latest `membership.remove` of each person from each class (it keeps a removed student's work in review, grading and the results export) and the latest `test_attempt.recovery_requested` of each attempt (its recovery state). Older events of those kinds are deleted as usual |

**Stored files that name people.** A results export (CSV, `classes/{classId}/exports/`) holds students' names and grades. Its download link lasts five minutes and no row refers to the file, so the daily object sweep (04:13, after retention) removes every export older than 24 hours (`UNREFERENCED_OBJECT_MIN_AGE_MS`). The sweep runs whatever the retention policy, so an export never keeps a deleted or anonymised student's name for more than a day plus the time to the next sweep; an instructor who needs the file again exports again. Files copied out of notebook sessions and working-copy revisions are swept the same way once no row refers to them.

Spec §17 asks the operator to decide session limits, expected concurrent classes and the execution budget before deployment: record the values chosen here, next to the host and region, when they are decided.

## Upgrades and rollback

`docker compose … up -d --build` rebuilds and restarts; `migrate` runs first, and api, relay and worker restart only after it succeeds. Migrations only move forward: **take a backup before every upgrade** ([backup-restore.md](backup-restore.md)), and roll back by restoring it. Restart order for a runner image change: update `RUNNER_RUNTIMES` and `RUNNER_IMAGES` together, pull on the runner host, restart `runner`, run the sample job. Connectors are updated by their owners; a connector below the server's minimum version is refused when it links.

## Connector downloads

Learners get the connector from this repository's GitHub releases (owner decision, 2026-10-08, issue #461). **Pushing a tag `connector-v<version>` on `main` publishes the release** (for example `connector-v0.1.0`): the `connector-release` workflow builds five unsigned binaries (`parallax-connector_<version>_<os>_<arch>[.exe]` for linux/amd64, linux/arm64, darwin/amd64, darwin/arm64, windows/amd64) and attaches them with that release's `SHA256SUMS`. Run the workflow by hand (`workflow_dispatch`) with `dry_run` off, selecting the tag, only to retry a tag whose push run failed before the release was created; with `dry_run` on (the default) it builds and checks without publishing. The device list in the web app links to `https://github.com/danielriosgarza/PlatosCave/releases` (`CONNECTOR_RELEASES` in `DeviceList.tsx`); a deployment from a fork must change that constant. The first release, `connector-v0.1.0`, was published on 2026-10-08; later versions are published the same way, by pushing the next `connector-v<version>` tag. Raise the server's minimum connector version only after the matching release exists.

## Managed connector

Optional (spec §10.6; connector design §12). Put the operator's files in `MANAGED_CONNECTOR_DIR`, owned by uid 65532: `identity.key` (mode 0600), `known_hosts`, `targets.json`, `keys/` (each key 0600). Register it once: `docker compose … run --rm api node_modules/.bin/tsx src/scripts/register-managed-connector.ts --name … --public-key …`, put the printed id in `PARALLAX_CONNECTOR_ID`, and start it with `--profile managed`. Its container has a read-only root, no capabilities and no route to Postgres or Garage. Which hosts it may dial is enforced twice: by its own `PARALLAX_ALLOW_*` allowlist and by the host's firewall, which must allow the `managed` network's egress only to those hosts and ports and to the relay's public address.

## Incidents

| Symptom | Look at | Do |
| --- | --- | --- |
| `/api/ready` 503, `database` unavailable | Postgres container, disk, connections | restore Postgres; api and relay recover without restart (the pool reconnects) |
| 503, `queue` skipped after a database outage | api/relay log `pg-boss error` at start | restart api and relay (the database check recovers alone, the queue does not: it is created only at start) |
| 503, `storage` unavailable | Garage health, credentials | check `garage` and `S3_*`; uploads and media fail until it answers |
| Code runs stay `queued` | `execution.run` depth and age; the runner's log; `docker ps` for sandboxes | restart `runner`; check `RUNNER_DB_PASSWORD`, `parallax_runner` has `LOGIN`, `DOCKER_GID`, the image pulled; a run whose runtime is missing from `RUNNER_IMAGES` ends `image_not_allowed` |
| Sign-in mail not arriving | api log `sign-in link could not be sent` (message and code, never the address) | fix `SMTP_URL`; people may request again, undelivered links are removed |
| Many `429` for sign-in at the start of a class | `remoteAddress` in the log is the proxy's | set `TRUST_PROXY`; raise `AUTH_LINK_RATE_LIMIT` only if the address is genuinely shared |
| Connectors offline after a deploy | relay log `connector link closed` | connectors redial on their own (close code 1001); more than one relay running is a fault |
| Suspected leak of a secret | — | rotate `SESSION_SECRET` (ends every session) and `CONTENT_TOKEN_SECRET` (invalidates content links), restart all services, and revoke what the secret guarded |

## Load testing

`.github/workflows/load-test.yml` (weekly and on demand) follows spec §14: 200 students start one test within a minute and poll their runs. Its limits need no change: run requests are limited per session, and every student has their own. If a load test still sees `429`, raise `RUN_RATE_LIMIT` in the job's environment, as `e2e/playwright.config.ts` does for `AUTH_LINK_RATE_LIMIT`.

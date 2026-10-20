# Operations runbook

How to run Parallax in production (spec §13, §14, §17). There are two deployments: a site's own installation on one host ([next section](#a-site-on-one-host)), and the repository's `infra/compose.prod.yml`, which the sections from [Topology](#topology) on cover: what to put in it, what to watch, and what to do when it is red. Backups have their own page: [backup-restore.md](backup-restore.md). The runner's host and network rules are in [design/runner.md](design/runner.md) §10; the connector's in [design/connector.md](design/connector.md) §12.

## A site on one host

A site at level 1 or 2 ([getting started](getting-started.md#make-a-site)) runs from its folder with the template's `compose.yml`: `postgres` (unless `.env` names an existing PostgreSQL 16 as `DATABASE_URL`), `migrate`, one `server` in relay mode that also serves `dist/`, `worker`, and `caddy`, which obtains a certificate for each of the two host names. There is no runner, Docker socket or object store; files are on the volume `storage`. Every `docker compose` call of `parallax` passes `--env-file .env --env-file .parallax/site.env -f compose.yml`, and `-f compose.level2.yml` at level 2. [Site design](design/site.md) §9 to §11 has the detail.

### First start of a site

1. Point both host names of `origins` at the host, and open ports 80 and 443, which Caddy needs for the certificates.
2. Run `npx parallax env`. It writes `.parallax/site.env` from the configuration and creates `.env` (mode 0600) with generated `POSTGRES_PASSWORD`, `SESSION_SECRET`, `CONTENT_TOKEN_SECRET` and `READY_PROBE_TOKEN` (and `RUNNER_DB_PASSWORD` at level 2). It never changes a value in `.env`, and names what it added: `parallax env: wrote .parallax/site.env; .env gained POSTGRES_PASSWORD, SESSION_SECRET, CONTENT_TOKEN_SECRET, READY_PROBE_TOKEN.` It writes `.parallax/site.env`, and at level 2 `pg_hba.conf` and `runner.env`, anew on every run, as `start` and `upgrade` do: change the configuration, not those files (with an existing PostgreSQL a `RUNNER_DATABASE_URL` typed into `runner.env` is kept; with the bundled database `env` replaces it). On Windows the mode does not apply and `.env` takes the permissions of its folder: keep the site in a folder only you can read.
3. Type into `.env`, **single-quoted**, what the configuration needs: `SMTP_URL='smtp://user:password@mail.example.org:587'` when `signIn` has `email`, `OIDC_CLIENT_SECRETS='{"university":"…"}'` when it lists providers, and `DATABASE_URL='postgres://…'` for an existing PostgreSQL. Compose replaces an unquoted `$name`, and a `#` after a space ends an unquoted value. `start` stops on such a value, and on a missing one, and names it: `parallax start: .env: SMTP_URL holds $ or \ that Compose would change: write it SMTP_URL='…'`.
4. Run `npx parallax start` (**Docker**): `env`, the check of `.env`, `build`, `docker compose pull` and `up -d --wait`, in which `migrate` runs before the services. It ends with `parallax start: the services are up.` and is safe to run again.
5. Each instructor of the configuration signs in once in the browser.
6. Run `npx parallax sync`, then `npx parallax apply` (both **Docker**); the instructor guide has [sync](guide/instructors.md#sync) and [apply](guide/instructors.md#classes-from-a-sites-configuration). `apply` prints each enrolment code or join link once, to this terminal only.

Caddy and the server read the `Caddyfile` and `dist/` with no special right, so `start` and `upgrade` make both readable to everyone (they hold no secret) and leave a symbolic link as it is. A `npx parallax build` alone leaves new files as the operator's umask makes them, and with 077 or 027 the server cannot read them: rebuild a running site with `npx parallax start`.

### Upgrade of a site

Change the version of `parallax-site` in `package.json`, run `npm install`, then `npx parallax upgrade` (**Docker**). While the old version still serves, it runs `env` and `start`'s check of `.env`, compiles the new site into `.parallax/dist` and pulls the images, the backup's included. It then stops `server` and `worker`, backs up the database and the files into `backups/<UTC time>`, puts the new site into `dist/` and runs `up -d --wait`, in which `migrate` runs first; it ends with `parallax upgrade: the new version is up; the backup taken before is backups/…`. A failure names its stage. A failed backup starts no migration, leaves `dist/` as it was and prints the command that starts the old services again; after a failed `up`, the message says that `server` and `worker` may be stopped (`docker compose ps` shows which) and names the backup. Migrations only move forward: `migrate` refuses a database newer than the package with `migrate: the database holds a migration of <date>, newer than this version's newest, of <date>.`, and prints any other failure in full, with its cause. Rollback is the earlier version and the backup taken before the upgrade, restored with `restore.sh` into an empty database ([backup and restore](backup-restore.md)); the tool has no restore command. The bundled database's URL holds no password, so a restore into it sets `PGPASSWORD` to `POSTGRES_PASSWORD` of `.env`.

### Level 2: the runner host

Level 2 adds `runner: { host, databaseHost, runtimes }` to `parallax.config.ts`: the runner host's IPv4 address, the site host's IPv4 address on a private network between the two (a provider's private network or a WireGuard link; Parallax does not encrypt this connection), never a public one, since PostgreSQL's port is published on it, and the sandbox runtimes in the form of `RUNNER_RUNTIMES` ([First start](#first-start), step 4). `npx parallax env` also writes `.parallax/pg_hba.conf` and `.parallax/runner/runner.env` and prints the pulls for the runner host:

```
parallax env: wrote .parallax/site.env, .parallax/pg_hba.conf and .parallax/runner/runner.env; .env gained RUNNER_DB_PASSWORD.
Pull on the runner host, before it starts:
  docker pull ghcr.io/<owner>/parallax-runner:<version>
  docker pull <each runtime's image>@<digest>
```

`npx parallax start` then publishes PostgreSQL only on `databaseHost` and sets the login of the role `parallax_runner`, which reaches schema `pgboss_exec` only. On the runner host (**Docker**, with gVisor as in [First start](#first-start), step 1), copy `compose.runner.yml` and `runner.env` there, run the pulls, and start it:

```
DOCKER_GID=$(stat -c %g /var/run/docker.sock) docker compose --env-file runner.env -f compose.runner.yml up -d
```

- With an existing PostgreSQL, `start` sets nothing: its administrator applies the same rules and the role's password, and you type `RUNNER_DATABASE_URL='postgres://parallax_runner:…@<databaseHost>:5432/parallax'` into `.parallax/runner/runner.env`, where `env` keeps it. Without it `env` writes none and says nothing.
- Set `RUNNER_SLOTS` (default 4) in the shell that starts the runner, not in `runner.env`, which `env` rewrites. `start` sets the role's connection limit to 8, which is 4 slots and 4; for more slots, set the limit to slots + 4 with `ALTER ROLE parallax_runner CONNECTION LIMIT …` after each `start`.
- The sandbox images are not published: build them with `scripts/runner-image.sh` from a copy of the repository.
- On a Linux engine the level 2 `postgres` has no route out of its host; on Docker Desktop it keeps one, because Docker Desktop ignores `enable_ip_masquerade`.

### Limits of a site's installation

- The subnets of `edge` and `backend` (`172.30.11.0/24`, `172.30.10.0/24`) can collide with a network on the host; each is one line of `compose.yml`.
- `compose.yml`, `Caddyfile`, `compose.level2.yml` and `compose.runner.yml` are copied from the template once: a later version that needs a new secret, volume, service or Caddy rule asks for an edit of them.
- `apply` issues a new enrolment code, and prints it, for every listed class that has no open enrolment invitation; an open class also gets one when each of its open invitations has a limit or an expiry. So a code that was revoked, has expired or is used up is replaced at the next `apply`, and an open class's new code has no limit and no expiry. It also sets a class's `open` back to the configuration when the two differ.
- `apply` waits for every listed instructor's first sign-in; a mistyped address in an `instructor.yaml` gives nobody the courses, and `apply` names the file.

## Sign-in

People sign in with an email link, through an OpenID Connect provider, or both (spec §3). On a site, `signIn` in `parallax.config.ts` sets them: `email: { from }` and `providers: [{ id, name, issuer, clientId }]`, with the secrets in `.env` ([first start](#first-start-of-a-site), step 3). In the server's own environment they are `MAIL_TRANSPORT`, `OIDC_PROVIDERS` and `OIDC_CLIENT_SECRETS` ([`.env.example`](../.env.example)); `MAIL_TRANSPORT=none` offers no email link and needs a provider. `infra/compose.prod.yml` passes no provider setting.

Register `<APP_ORIGIN>/api/auth/oidc/<id>/callback` at the issuer. The issuer must:

- verify addresses: accounts are keyed by a verified address, and the ID token must carry `email`, a valid address of at most 254 characters, and `email_verified: true`, a boolean. A missing claim, a string, or a claim sent only by the userinfo endpoint ends with *name* **did not confirm an email address**;
- accept `client_secret_basic`, the one way Parallax sends the client secret. With an issuer that offers only `client_secret_post`, every sign-in ends with **Signing in with** *name* **did not finish**;
- be configured exactly as it publishes itself: `issuer` is the `issuer` value of its `/.well-known/openid-configuration`.

An address in `INSTRUCTOR_EMAILS` (on a site, the addresses of the `instructor.yaml` files) may create courses once someone signs in with it, by an email link or through an issuer that says it verified the address. The list is only as safe as the address checks of every configured issuer.

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
2. **Environment file** `prod.env` (never committed; mode 0600). Required, no defaults: `POSTGRES_PASSWORD` and `RUNNER_DB_PASSWORD` (both go into connection URLs, so generate them URL-safe: `openssl rand -hex 32`; base64 output contains `/`, `+` and `=`), `APP_ORIGIN`, `APP_HOST`, `CONTENT_ORIGIN`, `CONTENT_HOST` (two host names, ADR-0002), `SESSION_SECRET` and `CONTENT_TOKEN_SECRET` (32 or more random characters each: `openssl rand -base64 48`), `READY_PROBE_TOKEN` (16 or more random characters, sent as `X-Ready-Token` by the health check and by any proxy or monitor probe of `/api/ready`: `openssl rand -hex 32`), `TRUST_PROXY`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `SMTP_URL`, `MAIL_FROM`, `GARAGE_CONFIG`, `DOCKER_GID`, `RUNNER_RUNTIMES`, `RUNNER_IMAGES`. `docker compose config` names the first one still missing. Set `INSTRUCTOR_EMAILS`, `RETENTION_DEACTIVATED_GRACE_DAYS` and `RETENTION_AUDIT_DAYS` before the first class (spec §13: retention is decided before production; each rule is off while unset).
3. **Garage.** Write your own `garage.toml` (the file in `infra/garage` carries a published development secret) and point `GARAGE_CONFIG` at it. Start `garage`, assign its layout, create the bucket `S3_BUCKET` and an access key with read and write on it, as `scripts/garage-init.sh` does for development; put the key in `prod.env`.
4. **Runtimes and images.** `RUNNER_RUNTIMES` (server) and `RUNNER_IMAGES` (runner) are two views of one decision and change together. Both list **every** runtime the course may select, today `python-3.12` and `r-4.6`, each pinned by digest: a runtime missing from `RUNNER_IMAGES` makes every run of it end `image_not_allowed`, and production refuses a runtime without a digest. Keep the previous digest in `RUNNER_IMAGES` after an update, so replays still find it (design §10.4). Pull the images on the runner's host first: `RUNNER_PULL` is `never`.
   ```
   RUNNER_RUNTIMES=[{"id":"python-3.12","language":"python","image":"registry.example.org/parallax-runner-python","digest":"sha256:…","harnessVersion":"4","packages":["numpy","pandas","scipy"]},{"id":"r-4.6","language":"r","image":"registry.example.org/parallax-runner-r","digest":"sha256:…","harnessVersion":"4","packages":["jsonlite"]}]
   RUNNER_IMAGES={"python-3.12":["registry.example.org/parallax-runner-python@sha256:…"],"r-4.6":["registry.example.org/parallax-runner-r@sha256:…"]}
   ```
5. **Start.** `docker compose --env-file prod.env -f infra/compose.prod.yml up -d --build postgres garage`, then the rest. `migrate` applies the schema and exits; api, relay and worker wait for it. The first migration creates the role `parallax_runner` when the connecting role may create roles (here it does); give it its password and login once: `ALTER ROLE parallax_runner LOGIN PASSWORD '<RUNNER_DB_PASSWORD>' CONNECTION LIMIT <slots + 4>;`, then `docker compose … restart runner`. A deployment that migrates with a less privileged role runs `scripts/runner-role.sql` first (design §10.3).
6. **Verify** (§Readiness): `curl -fsS -H "Host: $APP_HOST" -H "X-Ready-Token: $READY_PROBE_TOKEN" http://127.0.0.1:3000/api/ready` answers 200 with every check `ok`. Then run the sample job of design §10.4 through the real path.

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
| Liveness | `GET /api/health` | 200 `{"status": "ok"}` while the process serves; a probe also gets `version` and `db: ok | unavailable | skipped` | restart a hung process |
| Readiness | `GET /api/ready` | 200 `ready`, or 503 `not_ready`, with the same body | take an instance out of rotation; the compose health check |

**Who sees the readiness detail.** Only a request that sends the header `X-Ready-Token` equal to `READY_PROBE_TOKEN` (at least 16 characters, surrounding whitespace ignored; only `compose.prod.yml` requires it, so a deployment that does not use it must set it and send it from its probes) gets the readiness body below. The compose health check sends it from inside the container. A proxy's or load balancer's probe, and any external monitor, must send it too: without it a caller gets `{"status": "ready"}` or `{"status": "not_ready"}` with the same 200/503, no version, mode or dependency, and is limited to `READY_RATE_LIMIT` requests per address per minute (default 30, then `429`). A probe that polls faster than that and omits the token is answered `429` and a proxy will take a ready instance out of rotation. Requests with the token are never counted. Being on the Docker host or on loopback gives no detail: `curl http://127.0.0.1:3000/api/ready` there reaches the container through the published port and is an ordinary caller, so add `-H "X-Ready-Token: $READY_PROBE_TOKEN"`.

**Health follows the same rule, with its own budget.** `/api/health` shows `version` and `db` only to a request that sends `X-Ready-Token`; without the token a caller gets `{"status": "ok"}`, no `version` or `db`, no database query is run, and it is limited to `READY_RATE_LIMIT` requests per address per minute (then `429`). The process answering 200 is still the liveness signal, so a liveness probe that only needs that sends no token and polls slower than the limit; one that needs `db` sends `X-Ready-Token`.

The readiness body, for a probe, lists each dependency with `status` (`ok`, `unavailable`, `skipped`), `required`, and `latencyMs`; it never carries an error message, host or credential (the cause is in the log as `readiness: dependency unavailable`, field `dependency`).

| Check | Required | `unavailable` or `skipped` means |
| --- | --- | --- |
| `database` | yes | Postgres does not answer `select 1` within 5 s, or the process has no `DATABASE_URL` |
| `queue` | yes | pg-boss did not start against the database (`pg-boss error` in the log); jobs cannot be queued. The queue is started once, when the process starts: if Postgres was unreachable then, the check stays `skipped` after the database recovers until api and relay are restarted |
| `executionQueue` | no | the runner's queue (`pgboss_exec`) did not start: code runs answer 503, everything else works |
| `storage` | yes | the object store is unusable within 5 s: the bucket does not exist or answers an error (S3 `HeadBucket`, which needs the `s3:ListBucket` permission beside Get, Put and Delete of objects), or the storage directory cannot be written |

`/api/ready` runs a database query and a storage call on every request and names the failing dependency: use it from the compose health check and the proxy's own probe, both sending `X-Ready-Token`. The app itself withholds the detail and limits unknown callers, so the public host need not answer 404 for it, but a proxy that does is still the stronger setup. The worker and the runner serve no HTTP. The worker logs `worker started` with its job names, and exits non-zero when it cannot start; the runner's health is the queue: see §Incidents. Watch, per design §10.4, the depth of `execution.run` and the age of its oldest `created` job.

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
| **Readiness and health** (`/api/ready`, `/api/health`, callers without `X-Ready-Token`) | 30 / min each | client address | `READY_RATE_LIMIT` |
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
| `READY_RATE_LIMIT` | 30 | `/api/ready` and `/api/health` requests (each its own budget) per address per minute from callers that are not probes |
| `READY_PROBE_TOKEN` | unset (required by `compose.prod.yml`) | secret (16+ characters) the health check, a proxy probe or a monitor sends as `X-Ready-Token` to get the readiness detail (`/api/ready`) or `version` and `db` (`/api/health`) and skip `READY_RATE_LIMIT` |
| `AUTH_LINK_RATE_LIMIT`, `AUTH_VERIFY_RATE_LIMIT` | 120, 240 | sign-in limits per address per 15 minutes |
| `RUNNER_SLOTS` | 4 (1–32) | concurrent sandbox containers (runner) |
| `RETENTION_DEACTIVATED_GRACE_DAYS`, `RETENTION_AUDIT_DAYS` | unset (off) | retention policy (spec §13). The audit sweep keeps two kinds of event the product reads as state, whatever their age: the latest `membership.remove` of each person from each class (it keeps a removed student's work in review, grading and the results export) and the latest `test_attempt.recovery_requested` of each attempt (its recovery state). Older events of those kinds are deleted as usual |

**Export and archive screens.** Instructors export a class's results from Class review (**Export results (CSV)**): the link appears once the server has answered, works for five minutes, and holds the selected class only. Course owners archive and restore a class or a course from the cards on **Courses you teach**, and instructors who manage a class's members can archive and restore that class there too; an archived class or course stays readable and takes no writes until restored (restore the course before its classes). Students download their own annotations and posts for a class from that class's topic list (**Download my annotations**). All three call the existing API routes and are audited there.

**Stored files that name people.** A results export (CSV, `classes/{classId}/exports/`) holds students' names and grades. Its download link lasts five minutes and no row refers to the file, so the daily object sweep (04:13, after retention) removes every export older than 24 hours (`UNREFERENCED_OBJECT_MIN_AGE_MS`). The sweep runs whatever the retention policy, so an export never keeps a deleted or anonymised student's name for more than a day plus the time to the next sweep; an instructor who needs the file again exports again. Files copied out of notebook sessions and working-copy revisions are swept the same way once no row refers to them.

Spec §17 asks the operator to decide session limits, expected concurrent classes and the execution budget before deployment: record the values chosen here, next to the host and region, when they are decided.

## Upgrades and rollback

`docker compose … up -d --build` rebuilds and restarts; `migrate` runs first, and api, relay and worker restart only after it succeeds. Migrations only move forward: **take a backup before every upgrade** ([backup-restore.md](backup-restore.md)), and roll back by restoring it. Restart order for a runner image change: update `RUNNER_RUNTIMES` and `RUNNER_IMAGES` together, pull on the runner host, restart `runner`, run the sample job. Connectors are updated by their owners; a connector below the server's minimum version is refused when it links.

## Connector downloads

Learners get the connector from this repository's GitHub releases (owner decision, 2026-10-08, issue #461). **Pushing a tag `connector-v<version>` on `main` publishes the release** (for example `connector-v0.1.0`): the `connector-release` workflow builds five unsigned binaries (`parallax-connector_<version>_<os>_<arch>[.exe]` for linux/amd64, linux/arm64, darwin/amd64, darwin/arm64, windows/amd64) and attaches them with that release's `SHA256SUMS`. Run the workflow by hand (`workflow_dispatch`) with `dry_run` off, selecting the tag, only to retry a tag whose push run failed before the release was created; with `dry_run` on (the default) it builds and checks without publishing. The device list in the web app links to `https://github.com/danielriosgarza/PlatosCave/releases` (`CONNECTOR_RELEASES` in `DeviceList.tsx`); a deployment from a fork must change that constant. The first release, `connector-v0.1.0`, was published on 2026-10-08; later versions are published the same way, by pushing the next `connector-v<version>` tag. Raise the server's minimum connector version only after the matching release exists.

## Package releases

Pushing a tag `parallax-v<version>` on `main` publishes the npm packages `parallax-site` and `create-parallax-site` and the images `ghcr.io/<owner>/parallax-server` and `ghcr.io/<owner>/parallax-runner`, all under that version (`.github/workflows/package-release.yml`, [site design](design/site.md) §12). A pull request that changes what it packs, and a manual run with `dry_run` on (the default), build and check without publishing. No session pushes a tag. Before the first one, the owner:

1. holds the npm names `parallax-site` and `create-parallax-site`;
2. creates the environment `release` (**Settings → Environments → New environment**), sets its **Deployment branches and tags** to **Selected branches and tags** with one rule of ref type **Tag**, `parallax-v*`, adds themselves under **Required reviewers**, and adds to it the environment secret `NPM_TOKEN`: a granular npm access token with read and write access to the two packages (before the first publish, to all packages of the account, since the two do not exist yet; narrow it after), allowed to publish without a one-time password, and with an expiry date you note, since a publish fails once it has passed. Do not add `NPM_TOKEN` as a repository secret. Without the environment secret the step **The npm token is set** fails, before anything is pushed;
3. creates a tag ruleset (**Settings → Rules → Rulesets → New tag ruleset**) targeting `parallax-v*`, active, with **Restrict creations**, **Restrict updates** and **Restrict deletions**, and only the repository admin role in its bypass list;
4. settles the licence of the two manifests, which is still open ([site design](design/site.md) §14, question 3).

Steps 2 and 3 are both required. Only the job `publish` names the environment, so the run of a pull request cannot read `NPM_TOKEN`, even from an edited copy of the workflow. The environment admits any ref named `parallax-v*`, though, and the step that checks that the tag is on `main` is part of the workflow file: someone who could push a release tag on a commit of their own could have that commit's copy of the workflow read the token. The ruleset keeps everyone but an admin from creating, moving or deleting a release tag, and the required review makes every publish wait until the owner approves it, on a page that names the run's commit. Neither control tells a Claude session from the owner, since sessions act through the owner's account: for sessions, what holds is the rule that no session pushes a release tag or approves a deployment, and an approval request the owner did not expect is one to reject.

After the first publish, make both GHCR packages public (GHCR creates new packages as private), and link each to this repository in its package settings: neither image carries the label `org.opencontainers.image.source`.

Before anything is pushed, the step **The version is not published yet** stops the run when npm holds either package at the version or GHCR holds either image tag, and when npm or GHCR gives any answer other than "not found". A tag pushed again, or a manual run with `dry_run` off on a published tag, therefore stops there: the workflow as written never replaces a published image or version. **Known limit:** the images are pushed with the run's `GITHUB_TOKEN`, which the environment does not guard. The run of a pull request from a branch of this repository can be given `packages: write` by an edited copy of the workflow and push over a published image tag once the package is linked to the repository; the npm packages, whose token is in the environment, cannot be replaced that way, and npm never accepts a published version twice. Closing this needs the images pushed with a credential held in the environment and the repository's own access to the packages set to read in each package's **Manage Actions access**; it is not done.

**A run that stopped part way.** The images are pushed one after the other, then the npm packages, and a later run stops at **The version is not published yet** as soon as any of them is published, so such a run cannot be run again. Its artifact `parallax-release-<version>`, uploaded even when a step fails, holds the digests of the images it pushed. Either publish what is missing by hand from the run's artifact `parallax-<version>`: an image with `docker load --input images/parallax-<name>.tar` and `docker push ghcr.io/<owner>/parallax-<name>:<version>` after `docker login ghcr.io` with a token that may write packages, and a package with `npm publish ./release/<package>-<version>.tgz --access public --ignore-scripts`, `parallax-site` before `create-parallax-site`, adding `--tag next` for a prerelease. Or leave that version unfinished and push the next one (a prerelease such as `0.1.0-rc.2` costs nothing). Deleting a pushed image version in the package's settings and pushing the same tag again also works, but loses the record that the version was published.

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

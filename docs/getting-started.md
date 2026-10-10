# Getting started

Run Parallax on your own machine, sign in, and set up a first course and class. This page is for a developer or evaluator. For using the app, see the [instructor guide](guide/instructors.md) and the [student guide](guide/students.md). For production, see [operations](operations.md).

Every command here was run in a cloud session without Docker. Steps that need Docker are marked **Docker**.

## Prerequisites

| Tool | Version | Needed for |
| --- | --- | --- |
| Node.js | 22.12 or newer | everything |
| corepack (ships with Node) | | pnpm 10, pinned in `package.json` |
| PostgreSQL | 16 | the database: local server binaries, or Docker |
| Go | 1.24 | the compute connector in `connector/` only |
| Docker | recent, with Compose v2 | **Docker**: Compose services, runner sandboxes, Docker-only tests |

You can do without Docker unless you want code questions to run (the runner starts sandbox containers) or the optional services in `infra/compose.yml` (S3 storage, a mail inbox, connector fixtures).

## Install

```
corepack enable
pnpm install --frozen-lockfile
```

## Database

Pick one.

**Local server, no Docker.** Needs the Postgres 16 binaries (`initdb`, `pg_ctl`) on the machine.

```
pnpm db:local start
```

It prints `DATABASE_URL=postgres://parallax:parallax@127.0.0.1:54329/parallax`. Data lives in `/tmp/parallax-pg` (set `PARALLAX_PG_DIR` to move it). `pnpm db:local stop` and `pnpm db:local status` do what they say.

**Docker Compose.** **Docker**

```
pnpm compose up -d postgres
```

This serves the same URL on port 54329.

Then export the URL and migrate. The server does not read a `.env` file; set variables in the shell that starts it.

```
export DATABASE_URL=postgres://parallax:parallax@127.0.0.1:54329/parallax
pnpm db:migrate
```

`pnpm db:reset` creates the database if it is missing, drops the schemas `public`, `drizzle`, `pgboss` and `pgboss_exec` (all data and queued jobs), recreates `public` and migrates again. It refuses to run with `NODE_ENV=production`. Use it only on a database you can lose.

## Run

```
export INSTRUCTOR_EMAILS=teacher@example.org   # see "Sign in" below
pnpm dev
```

The API listens on `127.0.0.1:3000` and the web app on `http://localhost:5173`. **Open the app at `localhost:5173`.** The API treats `127.0.0.1` as the separate content origin, so `http://127.0.0.1:3000/api/...` answers 404 ([ADR-0002](adr/0002-authorization-and-class-isolation.md)). Settings and their defaults are listed in [`.env.example`](../.env.example).

By default files go to `apps/server/.local/storage` and sign-in mail goes to `apps/server/.local/mail`. Both folders are git-ignored.

## Sign in the first time

There is no password. You ask for a link by email; the link works once and expires after 15 minutes.

1. Open `http://localhost:5173/signin`, choose **Instructor sign in**, type an email address, and press **Send sign-in link**.
2. In development nothing is sent. The message is written as a JSON file in `apps/server/.local/mail/`. Open the newest file and copy the link in its `text` field.
3. Open the link in the same browser. You are signed in and sent to `/courses`.

Any address can request a link and gets an account on first use.

## Become an instructor

A new account is a student. It may create courses only if its email is in `INSTRUCTOR_EMAILS` (comma-separated, matched without case or surrounding spaces, read when the server starts) or it already teaches a course. Set the variable before `pnpm dev`, as above, then sign in with that address. The **Courses you teach** page then offers **Create course**.

## Create a course, a class and invite a student

The web app can create a course and let a student join a class. It has no screen yet for creating a class or issuing an enrolment code, so those two steps use the API. The commands below were run against a fresh database.

1. **Create a course** in the app: **Create course**, type a **Course title**. Or by API, with the instructor's session cookie in `jar.txt`:
   ```
   curl -b jar.txt -H 'content-type: application/json' -d '{"title":"Intro to Data"}' localhost:5173/api/courses
   ```
   To get the cookie, use `-c jar.txt` on the sign-in link request: `curl -c jar.txt "<link from the mail file>"`.
2. **Create a class** in that course (use the course `id` from step 1):
   ```
   curl -b jar.txt -H 'content-type: application/json' -d '{"name":"Spring 2027"}' localhost:5173/api/courses/<courseId>/classes
   ```
3. **Issue an enrolment code** for the class (use the class `id`):
   ```
   curl -b jar.txt -H 'content-type: application/json' -d '{"kind":"enrolment","maxUses":30}' localhost:5173/api/classes/<classId>/invites
   ```
   The answer holds a `code` such as `YNSRC-UVKWY`. Creating invitations needs a recent sign-in, so do it soon after signing in.
4. **Join as a student.** Sign in with another address (choose **Student sign in**, take the link from the mail folder), open `/courses`, and enter the code in **Invitation code**, then **Join class**. The class appears under the student's courses.

Add topics and materials in the course editor; see the [instructor guide](guide/instructors.md).

## Run the checks

| Command | What it runs | Needs |
| --- | --- | --- |
| `pnpm check` | lint, typecheck, unit and component tests, scenario records | nothing else |
| `pnpm lint` / `pnpm format` | Biome check / fix | |
| `pnpm test:integration` | server tests against a real database (about two minutes) | `DATABASE_URL` |
| `pnpm build && pnpm test:e2e` | Playwright against the built web app | `DATABASE_URL`, the Chromium that Playwright is pinned to |
| `pnpm test:runner` | runner tests | **Docker** for most of them; without Docker they skip |
| `cd connector && gofmt -l . && go vet ./... && go test ./...` | the Go connector | Go 1.24 |

Notes:

- The e2e run uses its own database, `parallax_e2e` on the same server (override with `E2E_DATABASE_URL`), and resets it. You can run one file: `pnpm test:e2e a02-membership`.
- Do not run `playwright install`. Playwright is pinned to the Chromium already on the machine (`PLAYWRIGHT_BROWSERS_PATH`).
- Each test title carries its scenario ID. `pnpm scenarios` checks that every scenario has a test and a record in `docs/delivery/done/`.

## Where code runs

Code questions and notebooks need something that runs the code. Without one, the rest of the app works and runs are refused.

- **Code questions (sample runs, tests)** run in sandbox containers started by the runner through Docker. **Docker**, and the runner images (`scripts/runner-image.sh build python|r`). Design: [runner](design/runner.md). This cannot run in a cloud session.
- **Notebooks** run on a computer the student or class connects through the Go connector (`connector/`, command `parallax-connector`), or on a managed connector. Design: [connector](design/connector.md). The local connector needs Jupyter and no Docker. Its Docker fixtures (`pnpm compose --profile connector …`) are used by the SSH tests and need **Docker**.
- **Object storage.** The default is the local folder. For S3-style storage run Garage with `pnpm compose --profile s3 up -d garage && bash scripts/garage-init.sh` (**Docker**) and set `STORAGE_DRIVER=s3` and the `S3_*` variables.
- **Real mail.** Set `MAIL_TRANSPORT=smtp`, `SMTP_URL` and `MAIL_FROM`. `pnpm compose --profile mail up -d mailpit` gives a local inbox at `http://localhost:8025` (**Docker**).

## Next

- [Operations runbook](operations.md) and [backup and restore](backup-restore.md) for a real deployment.
- [Delivery process](delivery/README.md) for how changes are made here.

# Getting started

Run Parallax on your own machine, sign in, and set up a first course and class. This page is for a developer or evaluator. For using the app, see the [instructor guide](guide/instructors.md) and the [student guide](guide/students.md). For production, see [operations](operations.md).

The commands here that do not need Docker were run in a cloud session. Steps that need Docker are marked **Docker**; they were not run there, because a cloud session has no Docker daemon.

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

Start two processes, each in its own shell with the same environment.

```
export DATABASE_URL=postgres://parallax:parallax@127.0.0.1:54329/parallax
export INSTRUCTOR_EMAILS=teacher@example.org   # see "Become an instructor" below
pnpm dev                                       # shell 1: API and web app
pnpm --filter @parallax/server worker          # shell 2: background jobs
```

`pnpm dev` does not start the job worker. Without the worker, jobs wait in the queue and never run: a reading, web slide deck or notebook added in the editor, or a PDF slide deck added through the API, stays **Waiting to be processed** and blocks publication, and scheduled result releases, deadline auto-submit, annotation mapping after a release is adopted, and retention do not happen.

The API listens on `127.0.0.1:3000` and the web app on `http://localhost:5173`. **Open the app at `localhost:5173`.** The API treats `127.0.0.1` as the separate content origin, so `http://127.0.0.1:3000/api/...` answers 404 ([ADR-0002](adr/0002-authorization-and-class-isolation.md)). [`.env.example`](../.env.example) lists the common settings and their defaults, but not all of them; [`apps/server/src/config.ts`](../apps/server/src/config.ts) is the full list. An evaluator may need two that are missing there: `SHINY_ORIGINS` (comma-separated origins a Shiny app may be embedded from; an app on any other origin is never shown to students, see the [instructor guide](guide/instructors.md)) and `RUNNER_RUNTIMES` (the runtimes code questions may select; in development it defaults to Python 3.12 and R 4.6, so you rarely set it).

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

The web app can create a course and let a student join a class. It has no screen yet for creating a class, issuing an enrolment code, accepting an instructor invitation, or adopting a release, so those steps use the API. The commands below were run end to end against a fresh database with the worker running.

Put the instructor's session cookie in `jar.txt`: request the sign-in link with `curl -X POST -H 'content-type: application/json' -d '{"email":"teacher@example.org"}' localhost:5173/api/auth/link`, then `curl -c jar.txt "<link from the mail file>"`.

1. **Create a course.** In the app: **Create course**, type a **Course title**. Or by API:
   ```
   curl -b jar.txt -H 'content-type: application/json' -d '{"title":"Intro to Data"}' localhost:5173/api/courses
   ```
2. **Create a class** in that course (use the course `id` from step 1):
   ```
   curl -b jar.txt -H 'content-type: application/json' -d '{"name":"Spring 2027"}' localhost:5173/api/courses/<courseId>/classes
   ```
   The creator is **not** an instructor of the new class. The class has no card under **Courses you teach**, and class review, preview, export and adoption answer 404 until you become one.
3. **Make yourself an instructor of the class.** Issue an instructor invitation to your own email, then accept it:
   ```
   curl -b jar.txt -H 'content-type: application/json' -d '{"kind":"instructor","email":"teacher@example.org"}' localhost:5173/api/classes/<classId>/invites
   curl -b jar.txt -H 'content-type: application/json' -d '{"token":"<code from the answer>"}' localhost:5173/api/invitations/accept
   ```
   The invitation is not emailed; the `code` in the answer is the `token` to accept. Creating invitations needs a recent sign-in, so do it soon after signing in. The class now shows under **Courses you teach**.
4. **Add content and publish it.** In the course editor add a topic and a reading (see the [instructor guide](guide/instructors.md)), then choose **Publish release**. By API: `POST /api/courses/<courseId>/releases`. The answer holds `release.id`.
5. **Adopt the release in the class.** A class shows no material until it adopts a release. There is no screen for this:
   ```
   curl -b jar.txt -H 'content-type: application/json' -d '{"releaseId":"<release.id>","expectedReleaseId":null}' localhost:5173/api/classes/<classId>/adopt
   ```
6. **Issue an enrolment code** for students:
   ```
   curl -b jar.txt -H 'content-type: application/json' -d '{"kind":"enrolment","maxUses":30}' localhost:5173/api/classes/<classId>/invites
   ```
   The answer holds a `code` such as `YNSRC-UVKWY`. An enrolment code is not tied to an email address.
7. **Join as a student.** Sign in with another address (choose **Student sign in**, take the link from the mail folder), open `/courses`, enter the code in **Invitation code**, then choose **Join class**. The class appears under the student's courses and its topic list shows the topic.

## Run the checks

| Command | What it runs | Needs |
| --- | --- | --- |
| `pnpm check` | lint, typecheck, unit and component tests, scenario records | nothing else |
| `pnpm lint` / `pnpm format` | Biome check / fix | |
| `pnpm test:integration` | server tests against a real database (about two minutes) | `DATABASE_URL` |
| `pnpm build && pnpm test:e2e` | Playwright against the built web app | a Postgres at `127.0.0.1:54329` (or `E2E_DATABASE_URL`), the Chromium that Playwright is pinned to |
| `pnpm test:runner` | runner tests | **Docker** for most of them; without Docker they skip |
| `cd connector && gofmt -l . && go vet ./... && go test ./...` | the Go connector | Go 1.24 |

Notes:

- The e2e run uses its own database, `postgres://parallax:parallax@127.0.0.1:54329/parallax_e2e`, set in `e2e/global-setup.ts` and not derived from `DATABASE_URL` (override with `E2E_DATABASE_URL`), and resets it. You can run one file: `pnpm test:e2e a02-membership`.
- Do not run `playwright install`. Playwright is pinned to the Chromium already on the machine (`PLAYWRIGHT_BROWSERS_PATH`).
- Each test title carries its scenario ID. `pnpm scenarios` checks that every scenario has a test and a record in `docs/delivery/done/`.

## Where code runs

Code questions and notebooks need something that runs the code.

With no runner process, the rest of the app works. In development the API accepts a sample run or an instructor's preview run and leaves it waiting until a runner takes it: students see **Queued**, an instructor's preview shows **Waiting for a runner** (`RUNNER_RUNTIMES` defaults to the development runtimes, and the API's `pgboss_exec` queue channel starts whenever Postgres is up). If that channel fails to start, the API answers 503 and the run panel shows **Run unavailable**.

- **Code questions (sample runs, tests)** run in sandbox containers started by the runner through Docker. Design: [runner](design/runner.md). This cannot run in a cloud session.

  **Docker.** Build the images, then start the runner in a third shell. Keep `pnpm dev` and the job worker running too: the API and the worker create the `pgboss_exec` schema (until then the runner logs `pgboss_exec is not ready` and retries every 10 seconds), and only the worker reads a run's result, so without it a run finishes in the sandbox but never settles in the app:

  ```
  scripts/runner-image.sh build python        # and: r
  export RUNNER_DATABASE_URL=$DATABASE_URL     # the application's own role; development only
  export RUNNER_IMAGES='{"python-3.12":["parallax-runner-python:dev"],"r-4.6":["parallax-runner-r:dev"]}'
  export RUNNER_PULL=missing                  # optional: pull an image that is not built locally; local :dev tags are used either way
  pnpm --filter @parallax/runner start
  ```

  `RUNNER_DATABASE_URL` and `RUNNER_IMAGES` are required. `RUNNER_IMAGES` is JSON mapping a runtime id to the image references it may run, newest first; it must cover the runtimes the API offers. Optional: `RUNNER_SLOTS` (concurrent containers, default 4), `RUNNER_PULL` (default `never`), `RUNNER_DOCKER_RUNTIME` (`runsc` in production) and `DOCKER_HOST`. The URL above reuses the application's own role, which is fine on a development machine. In production the runner connects as the role `parallax_runner`, which can reach schema `pgboss_exec` only ([runner design](design/runner.md) §8.4 and §10.3, [operations](operations.md)).

  Not run in a cloud session: building the images and everything that needs a Docker daemon. What was run there: with only `RUNNER_DATABASE_URL` and `RUNNER_IMAGES` set and no Docker, the process starts and, while neither the API nor the worker has created `pgboss_exec`, logs `pgboss_exec is not ready; retrying in 10 s`. Without `RUNNER_DATABASE_URL` it exits with `Invalid runner configuration`.
- **Notebooks** run on a computer the student or class connects through the Go connector (`connector/`, command `parallax-connector`), or on a managed connector. Design: [connector](design/connector.md). The local connector needs Jupyter and no Docker. Its Docker fixtures (`pnpm compose --profile connector …`) are used by the SSH tests and need **Docker**.
- **Object storage.** The default is the local folder. For S3-style storage run Garage with `pnpm compose --profile s3 up -d garage && bash scripts/garage-init.sh` (**Docker**) and set `STORAGE_DRIVER=s3` and the `S3_*` variables.
- **Real mail.** Set `MAIL_TRANSPORT=smtp`, `SMTP_URL` and `MAIL_FROM`. `pnpm compose --profile mail up -d mailpit` gives a local inbox at `http://localhost:8025` (**Docker**).

## Next

- [Operations runbook](operations.md) and [backup and restore](backup-restore.md) for a real deployment.
- [Delivery process](delivery/README.md) for how changes are made here.

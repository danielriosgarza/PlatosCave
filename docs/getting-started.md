# Getting started

Two ways in. [Make a site](#make-a-site) is for an instructor or a school: one command creates a site folder from the published packages, and the site is built at one of three levels. The sections from [Prerequisites](#prerequisites) on are for a developer or evaluator: run Parallax from this repository, sign in, and set up a first course and class. For using the app, see the [instructor guide](guide/instructors.md) and the [student guide](guide/students.md). For production, see [operations](operations.md).

The commands of **Make a site** that do not need Docker were run on 2026-10-20 in a local session on Windows, from packages packed in this repository, since nothing is published before the first release tag. The other commands here that do not need Docker were run in a cloud session. Steps that need Docker are marked **Docker**; they were not run.

## Make a site

A site is a folder with one project's configuration, its own pages and its course folders, and one dependency, `parallax-site`. You need Node.js 22.12 or newer with npm; levels 1 and 2 also need Docker with Compose v2 on the host that serves the site. Designs: [site toolkit](design/site.md), [course folder](design/course-folder.md), [open site](design/open-site.md).

### Create it

```
npm create parallax-site my-site                          # instructor mode
npm create parallax-site my-school -- --template school   # school mode
cd my-site
npm install
npx parallax --help
```

The first command asks nothing, runs no install and refuses a folder that is not empty; it prints `Created my-site from the instructor template. Next: cd my-site, then npm install.` `package.json` names the exact version of `parallax-site`, and no other file of the site does. `npx parallax --help` lists the commands: `apply, build, check, dev, env, start, sync, upgrade`. The template's values are samples on `example.org`: replace `name`, `origins` and `signIn` in `parallax.config.ts` and the address in each `instructor.yaml` (the instructor template has one, the school template one per folder under `instructors/`) before a first start or a deployed build.

| File | Holds |
| --- | --- |
| `parallax.config.ts` | `mode`, `name`, an optional `logo` (PNG, JPEG or WebP), `level`, `origins` (two host names, and optionally `shiny`, the origins Shiny apps may be framed from), `signIn`, `classes`, and at level 2 `runner` (two IPv4 addresses and the runtimes) |
| `instructor.yaml` | the instructor's `name` and `email` |
| `courses/<course>/` | the course folders ([instructor guide](guide/instructors.md#courses-from-a-folder)) |
| `src/pages/` | the site's own pages, JSX only: `index.tsx` is the front page at `/`, `about.tsx` is `/about`; styles are `*.module.css` files beside them |
| `compose.yml`, `Caddyfile`, `compose.level2.yml`, `compose.runner.yml` | the installation at levels 1 and 2 ([operations](operations.md#a-site-on-one-host)) |

Git ignores `node_modules/`, `dist/`, `.parallax/`, `.env` (and any `.env.*` or `*.env` file), `backups/` and `private/`. Every command first checks the configuration and the instructor folders, prints one line per problem (`parallax.config.ts: classes[1].course: no folder courses/genetics`) and exits 1 before it writes anything. Rules that span several fields are checked once each field is valid, so a second run can show a line the first did not. A page at the address of a Parallax screen, or under `/courses`, `/api`, `/assets` or `/content`, stops the build, which names both. So does a stylesheet that is not a `*.module.css`, declares a `--pc-*` token (as a property or with `@property`), uses `:global` or `@import`, or has a selector without a class. That rule guards against accidents and is not a boundary: a page is the site owner's own code, and at levels 1 and 2 it runs with the visitor's session. At levels 1 and 2, `npx parallax dev` serves the site with pages that reload on save and sends `/api` to `127.0.0.1:3000`.

### Two modes

- **Instructor mode** (`mode: 'instructor'`): one instructor; `instructor.yaml` and `courses/` are at the top of the site, and a class names its course as `statistics`.
- **School mode** (`mode: 'school'`): several instructors, each in `instructors/<name>/` with an `instructor.yaml` and a `courses/` of their own. `instructors: ['ana', 'ben']` lists the folders, a class names its course as `ana/reef-ecology`, and the front page lists the instructors, then their courses.

A `courses/` folder moves between the modes unchanged; its overlay in `private/` moves to the matching path ([instructor guide](guide/instructors.md#courses-from-a-folder)). The account with the verified address of an `instructor.yaml` owns that folder's courses, and those addresses are the site's `INSTRUCTOR_EMAILS`. A folder on disk that `instructors` leaves out, or a listed folder that is missing, stops every command. A mode adds no role.

### Three levels

| Level | Plugged in | Unlocks | Served by |
| --- | --- | --- | --- |
| 0. Open site | nothing: no server, database or sign-in | anyone reads slides, readings and rendered notebooks; Exercises and Tests list titles only | `npx parallax build`, then two static hosts |
| 1. Class | the server, PostgreSQL 16 and a way to sign in | accounts, classes, notes, exercises, tests, review, discussion, connected notebooks | `npx parallax start` on one host (**Docker**) |
| 2. Code checks | level 1 and a runner on a host of its own | sample runs and automatic grading of code questions | as level 1, and the runner host (**Docker**) |

`level` in `parallax.config.ts` sets it ([spec §13](product-spec.md#installation-levels-and-boundaries)). At level 0, `env`, `start`, `upgrade` and `apply` exit 1 (`parallax apply: level 0 has no server; apply is for levels 1 and 2.`) and `sync` exits 2. Levels 1 and 2: [operations](operations.md#a-site-on-one-host).

### Level 0: an open site

With `level: 0` in `parallax.config.ts` (the templates have `level: 1`):

```
npx parallax build
```

The build reads the course folders and nothing else, checks and converts them as publication does, and stops on a problem that would block publication. It writes `dist/site` for the host of `origins.app` and `dist/content` for the host of `origins.content`, and stops when the two hosts are the same. It leaves out every exercise and test definition and every resource marked `hidden`, and holds no account, note, attempt or grade. Each build replaces `dist/`, so a resource hidden or removed since the last build is gone from it.

The hosting must give:

1. **Two host names**, each serving its tree at its root; two paths of one host do not count. A folder's `index.html` must answer the folder's address, which every static host does; no rewrite rule is needed.
2. **For PDFs, cross-origin range requests from the content host.** A `GET` from the site's origin, with or without a `Range` header, gets `Access-Control-Allow-Origin` for that origin (or `*`); a ranged one gets status 206 and `Content-Range`; `Access-Control-Expose-Headers` names `Content-Range, Accept-Ranges, Content-Length`; and the preflight that the `Range` header causes gets a 2xx answer with `Access-Control-Allow-Origin` for that origin and `Access-Control-Allow-Headers: range`. [`e2e/static-server.ts`](../e2e/static-server.ts) gives exactly these answers. Without them a PDF says it could not be loaded and keeps its download link.

A file opened on the content host runs as that host, and can read and set the cookies of its registrable domain. The templates' sample origins (`stats.example.org` and `content.stats.example.org`, or `school.example.org` and `content.school.example.org`) are placeholders: if any other application on that registrable domain uses cookies, give the content host a domain of its own. Deploy by mirroring, so that each host ends up with exactly the new tree and loses what the tree no longer holds (rsync and `aws s3 sync` do so with `--delete`). A host that is only added to, by `scp -r`, `aws s3 cp --recursive` or a copy onto a pages branch, keeps the files of hidden or removed resources at their permanent addresses. Files a host asks for, such as `_headers`, `CNAME` or `.nojekyll`, are not part of a build: add them to `dist/site` or `dist/content` after every build.

A static host enforces nothing for Parallax: the build sets no response header, and the shell has no content security policy. Whether to recommend headers for hosts that can set them is an open owner question ([open site design](design/open-site.md) §12, question 2), so this guide recommends none. **Download notebook without outputs** is a link to the content host, and a browser may show the file as text (Chromium does), from where the visitor saves it. An upgrade at level 0 is a new version in `package.json`, `npm install` and `npx parallax build`.

### Moving between levels

A site changes level by changing `level` and running the commands of the new level.

- **To level 0.** Export first: instructors download each class's results (**Export results (CSV)**) and students their annotations (**Download my annotations**). Then run `npx parallax sync` (**Docker**): it stops and names each file whose latest revision was made in the editor, and its report counts the topics and resources made only in the editor. None of that is in the folder, so none of it is on a level 0 site. Take a backup: `npx parallax upgrade` (**Docker**) with the version unchanged stops `server` and `worker`, writes one into `backups/<UTC time>` and starts the same version again. Stop the services (**Docker**: `docker compose --env-file .env --env-file .parallax/site.env -f compose.yml stop`), and at level 2 the runner on its host. Until then `level` stays 1 or 2, since `sync` and `upgrade` refuse at level 0; now set `level: 0` in `parallax.config.ts`, and `npx parallax build` replaces `dist/`. Keep the volumes and `backups/`: the database is kept as a backup and never published.
- **To level 1.** Set `level: 1` and `signIn`, then follow the [first start](operations.md#first-start-of-a-site).
- **Between levels 1 and 2.** Add or remove `runner` with the level, and run `npx parallax start` (**Docker**); level 2 also needs the [runner host](operations.md#level-2-the-runner-host), and leaving it, the runner stopped there.

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

The API listens on `127.0.0.1:3000` and the web app on `http://localhost:5173`. **Open the app at `localhost:5173`.** The API treats `127.0.0.1` as the separate content origin, so `http://127.0.0.1:3000/api/...` answers 404 ([ADR-0002](adr/0002-authorization-and-class-isolation.md)). [`.env.example`](../.env.example) lists the common settings and their defaults, but not all of them; [`apps/server/src/config.ts`](../apps/server/src/config.ts) is the full list. An evaluator may need two that are missing there: `SHINY_ORIGINS` (comma-separated origins a Shiny app may be embedded from; an app on any other origin is never shown to students, see the [instructor guide](guide/instructors.md)) and `RUNNER_RUNTIMES` (the runtimes code questions may select; in development it defaults to Python 3.12 and R 4.6, so you rarely set it). Each `SHINY_ORIGINS` entry must be https, or http on a loopback host; it must not be the app or content origin, and its host must not be `APP_HOST` (`localhost` by default), otherwise the API and the worker refuse to start. `http://localhost:3838` is therefore rejected and `http://127.0.0.1:3838` works.

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

With no runner process, the rest of the app works. In development the API accepts a sample run or an instructor's preview run and leaves it waiting until a runner takes it (a student's waiting runs count toward the limit of two live runs; a new run of the same question in the same attempt replaces its waiting run, so the limit mostly blocks runs of different questions, and the student must cancel one to start another): students see **Queued**, an instructor's preview shows **Waiting for a runner** (`RUNNER_RUNTIMES` defaults to the development runtimes, and the API's `pgboss_exec` queue channel starts whenever Postgres is up). If that channel fails to start, the API answers 503: a student's run panel shows **Run unavailable**, and an instructor's preview shows **The run could not be started.**

- **Code questions (sample runs, tests)** run in sandbox containers started by the runner through Docker. Design: [runner](design/runner.md). This cannot run in a cloud session.

  **Docker.** Build the images, then start the runner in a third shell. Keep `pnpm dev` running: the API queues the runs and reads their results, and it creates the `pgboss_exec` schema (the worker does too); until the schema exists the runner logs `pgboss_exec is not ready` and retries every 10 seconds. Keep the job worker running as well: it supervises `pgboss_exec`, expiring the active job of a runner that died and consuming run results and dead letters (a failed grading run becomes NeedsReview). It also queues grading for submissions made automatically at a deadline. The submit route queues grading itself, and the API settles runs when they are read.

  In the third shell, export `DATABASE_URL` as in the Run section first:

  ```
  scripts/runner-image.sh build python
  scripts/runner-image.sh build r
  export RUNNER_DATABASE_URL=$DATABASE_URL     # the application's own role; development only
  export RUNNER_IMAGES='{"python-3.12":["parallax-runner-python:dev"],"r-4.6":["parallax-runner-r:dev"]}'
  pnpm --filter @parallax/runner start
  ```

  `RUNNER_DATABASE_URL` and `RUNNER_IMAGES` are required. `RUNNER_IMAGES` is JSON mapping a runtime id to the image references it may run, newest first; it must cover the runtimes the API offers. Build both images (Python and R): once the runner's retries are exhausted and the worker consumes the dead letter, a runtime whose image is not built ends its runs as **Run unavailable**. Optional: `RUNNER_SLOTS` (concurrent containers, default 4), `RUNNER_PULL` (default `never`; `missing` pulls an image that is absent, which helps only with registry references, since the `:dev` images exist only where you built them), `RUNNER_DOCKER_RUNTIME` (`runsc` in production) and `DOCKER_HOST`. The URL above reuses the application's own role, which is fine on a development machine. In production the runner connects as the role `parallax_runner`, which can reach schema `pgboss_exec` only ([runner design](design/runner.md) §8.4 and §10.3, [operations](operations.md)).

  Without Docker the runner does not get as far as running code. In the usual case `pnpm dev` is running and `pgboss_exec` exists: the runner starts its queue connection, then its container sweep fails because there is no Docker daemon, and the process exits with code 1 and a Docker error. If the API and worker have not created `pgboss_exec` yet, it logs `pgboss_exec is not ready` and retries; without `RUNNER_DATABASE_URL` it exits with `Invalid runner configuration`.
- **Notebooks** run on a computer the student or class connects through the Go connector (`connector/`, command `parallax-connector`), or on a managed connector. Design: [connector](design/connector.md). The local connector needs Jupyter and no Docker. Its Docker fixtures (`pnpm compose --profile connector …`) are used by the SSH tests and need **Docker**.
- **Object storage.** The default is the local folder. For S3-style storage run Garage with `pnpm compose --profile s3 up -d garage && bash scripts/garage-init.sh` (**Docker**) and set `STORAGE_DRIVER=s3` and the `S3_*` variables.
- **Real mail.** Set `MAIL_TRANSPORT=smtp`, `SMTP_URL` and `MAIL_FROM`. `pnpm compose --profile mail up -d mailpit` gives a local inbox at `http://localhost:8025` (**Docker**).

## Next

- [Operations runbook](operations.md) and [backup and restore](backup-restore.md) for a real deployment.
- [Delivery process](delivery/README.md) for how changes are made here.

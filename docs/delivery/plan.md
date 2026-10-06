# Parallax — delivery plan

Companion to the ADRs in `docs/adr/`. The product specification (`docs/product-spec.md`) is canonical; this plan only orders and sizes the work. Phase 0 is specified exactly because the next session builds it from this text. Phases 1–4 are work items, one PR each.

## 0. Conventions for every item

- **One item = one GitHub issue = one PR.** Issues are titled `[<ID>] <Title>`; the PR carries the same title and `Closes #<issue>`. The orchestrator assigns the branch `claude/<id>-<slug>` (see [README.md](README.md) for the full process). Target ≤ 600 changed lines excluding lockfiles, `routeTree.gen.ts`, `drizzle/meta`, generated migrations and fixtures. If an item grows past that, split it: create the extra issue as `.claude/skills/implement-issue` describes and update this plan in the same PR. Once issues exist, they are the live source of truth for status; this file records scope.
- **Fields**: `Scope` (what exists when done), `Spec` (sections), `Scenarios` (acceptance IDs whose automated tests this item adds; may be partial), `Depends on`, `Model` (sonnet | opus | fable), `Security` (yes/no), `Size` (S ≈ ≤ 250 lines, M ≈ ≤ 600), `Touches` (files likely edited; used to keep concurrent PRs apart).
- **Definition of done** (ADR-0006): tests titled with the scenario IDs (`test('A05 …')`), `pnpm check` green locally, CI green, the PR's **Scenarios** section lists IDs and test names, `docs/delivery/done/<ID>.txt` lists the IDs whose tests landed (§6), and this plan is edited if the item changed scope.
- **Model rules**: sonnet for well-specified low-risk work (UI from the wireframe, CRUD, tests, docs, config); opus for data model, permissions, anchoring, state machines, notebook protocol; fable (label name kept; implemented by Opus 5.5 at maximum effort) only for design documents and decisions whose error is very costly. `Security: yes` items get a security-focused review pass.
- **Hot spots and how they are serialised**:
  - *Migration chain*: drizzle-kit's `drizzle/meta/_journal.json` conflicts when two PRs add migrations. Only these items add migrations, in this order, each depending on the previous: **P0-02 → P1-01 → P1-04 → P2-04 → P2-10 → P2-14 → P2-16 → P3-02 → P3-15 → P3-06 → P3-16 → P4-01 → P4-09**. Other items must not add migrations; if one needs a column, it is added to the next chain item. Migration files are named `NNNN_<item-id>_<slug>.sql`.
  - *Schema barrel* `apps/server/src/db/schema/index.ts`: one `export *` line per domain file; only chain items touch it.
  - *Route registration*: no barrel. Server route modules are auto-discovered (`http/routes/*.routes.ts`); web routes are file-based; contracts live in `packages/contracts/src/routes/<domain>.ts`. New features add files, not lines in shared lists.
  - *Scope resolver* (`apps/server/src/auth/scope.ts`), *content origin* (`http/content.ts`), *global CSS* (`apps/web/src/styles/global.css`), *CI workflow*: owned by the items that introduce them; later items extend via new files where possible.
- **Environment facts** every session must respect: Node 22, pnpm 10.33.0, Go 1.24.7, Python 3.11, Postgres 16 binaries, Playwright 1.56.1 with `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` (never run `playwright install` in the cloud container), **no Docker daemon in cloud sessions** (CI has one). `pnpm db:local start` gives a local Postgres without Docker.

## 1. Phase 0 — walking skeleton (three sequential PRs)

Goal: a repository that installs, lints, type-checks, runs a web page backed by an API backed by Postgres, passes one test of each kind, builds a container image, and does all of that in GitHub Actions in under ten minutes. No product features.

### 1.1 Directory tree after Phase 0

```
.
├── .github/workflows/ci.yml  image.yml   .github/pull_request_template.md (exists)
├── .claude/settings.json (exists with the owner's merge permission; P0-01 adds `hooks`)  scripts/session-start.sh
├── CLAUDE.md (exists; P0 items keep its Commands section accurate)
├── .editorconfig  .dockerignore  .node-version (22)  .env.example  .gitignore (extended)
├── package.json (parallax, root scripts)  pnpm-workspace.yaml  pnpm-lock.yaml
├── biome.json  tsconfig.base.json  vitest.config.ts
├── apps/
│   ├── server/                         @parallax/server
│   │   ├── package.json  tsconfig.json  drizzle.config.ts
│   │   ├── drizzle/0000_p0-02_app_settings.sql  drizzle/meta/…        (generated, committed)
│   │   ├── src/main.ts                 CLI: `api` (default); `worker` (P1-07), `relay` (P3-02a) later
│   │   ├── src/config.ts               zod-validated environment
│   │   ├── src/app.ts                  buildApp(config, deps)
│   │   ├── src/http/register.ts        registerRoute + onRoute scope guard (ADR-0002)
│   │   ├── src/http/register.test.ts
│   │   ├── src/http/routes/health.routes.ts   src/http/routes/openapi.routes.ts
│   │   ├── src/http/static.ts          SPA serving when STATIC_DIR is set
│   │   ├── src/db/client.ts  src/db/migrate.ts  src/db/reset.ts
│   │   ├── src/db/schema/index.ts  src/db/schema/app.ts        (table app_settings)
│   │   └── test/integration/global-setup.ts  test/integration/db.ts  test/integration/health.itest.ts
│   └── web/                            @parallax/web
│       ├── package.json  tsconfig.json  vite.config.ts  index.html
│       └── src/main.tsx  src/routeTree.gen.ts (generated, committed)
│           src/routes/__root.tsx  src/routes/index.tsx
│           src/api/client.ts  src/components/GlobalBar.tsx  GlobalBar.module.css  GlobalBar.test.tsx
│           src/styles/global.css  src/test/setup.ts
├── packages/
│   ├── contracts/                      @parallax/contracts
│   │   └── src/define.ts  define.test.ts  index.ts  routes/health.ts
│   └── ui/                             @parallax/ui
│       └── src/tokens.css  tokens.test.ts  index.ts
├── connector/                          Go module `parallax/connector`
│   ├── go.mod  go.sum
│   ├── cmd/parallax-connector/main.go  (prints version; real CLI in P3-03)
│   └── internal/version/version.go  version_test.go
├── e2e/                                @parallax/e2e
│   ├── package.json  tsconfig.json  playwright.config.ts  global-setup.ts
│   └── tests/smoke.e2e.ts
├── infra/compose.yml  infra/docker/server.Dockerfile
├── scripts/pg-local.sh  scripts/check-scenarios.ts
└── docs/ (unchanged) + docs/adr/ + docs/delivery/
```

### 1.2 Package names, versions and root scripts

Root `package.json` (`"name": "parallax"`, `"private": true`, `"type": "module"`, `"packageManager": "pnpm@10.33.0"`, `"engines": { "node": ">=22.12" }`):

| script | command |
| --- | --- |
| `dev` | `pnpm -r --parallel --stream dev` (server on 3000 via `tsx watch`, web on 5173 via Vite with `/api` proxy) |
| `build` | `pnpm --filter @parallax/web build` (server needs no build; it runs under `tsx`) |
| `lint` / `format` | `biome ci .` / `biome check --write .` |
| `typecheck` | `pnpm -r typecheck` (each package: `tsc --noEmit`) |
| `test` | `vitest run --project unit --project component` |
| `test:integration` | `vitest run --project integration` (needs `DATABASE_URL`) |
| `test:e2e` | `pnpm --filter @parallax/e2e test` (Playwright; needs `DATABASE_URL` reachable and a built web app) |
| `check` | `pnpm lint && pnpm typecheck && pnpm test && pnpm scenarios` (P0-01 and P0-02 omit `pnpm scenarios`; P0-03 adds it with the script) |
| `db:migrate` / `db:generate` / `db:reset` | `pnpm --filter @parallax/server db:migrate` etc. |
| `db:local` | `bash scripts/pg-local.sh` (`start` \| `stop` \| `status`) |
| `compose` | `docker compose -f infra/compose.yml` (e.g. `pnpm compose up -d --wait`) |
| `scenarios` | `tsx scripts/check-scenarios.ts` |

Root devDependencies: `@biomejs/biome 2.5.14`, `typescript 5.9.3`, `vitest 5.0.2`, `tsx 4.23.15`, `@types/node 22.20.4`. Exact versions (no carets) everywhere; Renovate/Dependabot can bump later.

`pnpm-workspace.yaml`: `packages: ['apps/*', 'packages/*', 'e2e']`. If `pnpm install` reports ignored build scripts (expected: `esbuild`), add them under `onlyBuiltDependencies` in the same file.

Per-package dependencies:

- **@parallax/contracts**: `zod 4.6.5`. Exports: `"."` → `./src/index.ts`, `"./routes/*"` → `./src/routes/*.ts`.
- **@parallax/ui**: no runtime deps; devDep `yaml 2.9.1` (test). Exports `"."` → `./src/index.ts` (exports a `tokenNames` string array listing every `--pc-*` property, used by the test), `"./tokens.css"` → `./src/tokens.css`.
- **@parallax/server**: `fastify 5.12.5`, `fastify-type-provider-zod 7.0.0`, `@fastify/swagger 9.9.0`, `@fastify/sensible 6.0.6`, `@fastify/static 10.1.5`, `zod 4.6.5`, `drizzle-orm 0.45.3`, `pg 8.23.0`, `pino 10.3.1`, `tsx 4.23.15`, workspace `@parallax/contracts`; dev: `drizzle-kit 0.31.11`, `pino-pretty 13.1.3`, `@types/pg` (latest 8.x). Scripts: `dev: tsx watch src/main.ts api`, `start: tsx src/main.ts api`, `typecheck: tsc --noEmit`, `db:generate: drizzle-kit generate`, `db:migrate: tsx src/db/migrate.ts`, `db:reset: tsx src/db/reset.ts`.
- **@parallax/web**: `react 19.3.0`, `react-dom 19.3.0`, `@tanstack/react-router 1.170.40`, `@tanstack/react-query 5.104.0`, workspace `@parallax/contracts`, `@parallax/ui`; dev: `vite 8.3.1`, `@vitejs/plugin-react 6.1.1`, `@tanstack/router-plugin 1.168.41`, `@types/react 19.3.0`, `@types/react-dom 19.3.0`, `jsdom 30.1.1`, `@testing-library/react 16.3.3`, `@testing-library/user-event 14.6.7`, `@testing-library/jest-dom 7.0.1`. Scripts: `dev: vite`, `build: vite build`, `typecheck: tsc --noEmit`.
- **@parallax/e2e**: dev `@playwright/test 1.56.1`, `@axe-core/playwright 4.13.0`. Scripts: `test: playwright test`, `typecheck: tsc --noEmit`.
- **connector** (Go): `go 1.24` directive, no third-party deps in Phase 0.

### 1.3 Tooling configuration

`tsconfig.base.json`: `target ES2023`, `module ESNext`, `moduleResolution Bundler`, `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `isolatedModules`, `skipLibCheck`, `esModuleInterop`, `resolveJsonModule`, `noEmit`, `types: ["node"]`. Web adds `lib: ["ES2023","DOM","DOM.Iterable"]`, `jsx: "react-jsx"`, `types: ["vite/client"]`. Relative imports need no extensions (tsx and Vite both resolve them).

`biome.json`: `$schema` for 2.5.14; `vcs` enabled with git ignore file; `files.includes: ["**", "!**/dist", "!**/routeTree.gen.ts", "!**/drizzle/meta", "!.local", "!docs/wireframe.html"]`; formatter: spaces, width 2, lineWidth 100; JS: single quotes, semicolons always, trailing commas all; linter: `recommended: true`; assist organize imports on. Run `pnpm exec biome migrate` if the schema complains.

`vitest.config.ts` (root) declares three projects: `unit` (`packages/**/*.test.ts`, `apps/server/src/**/*.test.ts`, `scripts/**/*.test.ts`, environment node), `component` (`extends: 'apps/web/vite.config.ts'`, root `apps/web`, `src/**/*.test.tsx`, environment jsdom, `setupFiles: ['src/test/setup.ts']` which imports `@testing-library/jest-dom/vitest`), `integration` (`apps/server/test/integration/**/*.itest.ts`, `globalSetup`, `testTimeout 15000`, `hookTimeout 60000`).

`apps/web/vite.config.ts`: plugins `tanstackRouter({ target: 'react', autoCodeSplitting: true })` then `react()`; `server.port 5173`, `server.proxy['/api'] = 'http://127.0.0.1:3000'` (do **not** proxy `/content`; it must stay a different origin, P1-06); `build.outDir 'dist'`, `sourcemap true`.

`apps/server/drizzle.config.ts`: `dialect 'postgresql'`, `schema './src/db/schema/index.ts'`, `out './drizzle'`, `casing 'snake_case'`, `dbCredentials.url = process.env.DATABASE_URL`.

`.env.example`: `DATABASE_URL=postgres://parallax:parallax@127.0.0.1:54329/parallax`, `PORT=3000`, `HOST=127.0.0.1`, `LOG_LEVEL=info`, `STATIC_DIR=` (empty in dev). `.gitignore` adds `node_modules/`, `dist/`, `.local/`, `coverage/`, `e2e/playwright-report/`, `e2e/test-results/`, `*.tsbuildinfo`.

### 1.4 Server skeleton (what the code does)

- `config.ts`: `Env = z.object({ NODE_ENV: enum(development|test|production) default development, PORT: coerce number 3000, HOST default '127.0.0.1', DATABASE_URL: string optional, STATIC_DIR: string optional, LOG_LEVEL default 'info' })`; `loadConfig(env = process.env)`.
- `app.ts`: `buildApp(config, deps: { db?: Db })` creates Fastify with pino (pretty in development), sets `validatorCompiler`/`serializerCompiler` from `fastify-type-provider-zod`, adds the **onRoute guard** (`route.url.startsWith('/api/') && !route.config?.scope → throw Error('… has no scope; use registerRoute()')`), registers `@fastify/sensible`, `@fastify/swagger` (`openapi.info`, `transform: jsonSchemaTransform`), then every module matching `http/routes/*.routes.ts` in name order (each default-exports `(app, deps) => void`), then `static.ts` if `STATIC_DIR` is set (assets under `/assets` with long cache; any other non-`/api` GET returns `index.html`).
- `http/register.ts`: `registerRoute(app, contract, handler)` calls `app.route` with `schema` from the contract's zod objects (`params`, `querystring`, `body`, `response: { 200 }`), `config: { scope: contract.scope, contract }`, and a handler adapter passing `{ params, query, body, req, reply }`. In Phase 0, any scope other than `public` responds 401 (`scope resolution arrives in P1-01`); the guard and helper are the structural parts that must exist now.
- `routes/health.routes.ts`: `GET /api/health` → `{ status: 'ok', version, db: 'ok' | 'unavailable' | 'skipped' }` (runs `select 1` when `deps.db` exists). `routes/openapi.routes.ts`: `GET /api/openapi.json` → `app.swagger()`.
- `db/client.ts`: `createDb(url)` → `{ db: drizzle(pool, { schema, casing: 'snake_case' }), pool }`. `db/migrate.ts`: `runMigrations(url)` using `drizzle-orm/node-postgres/migrator` with `migrationsFolder` resolved relative to the file; runnable as a script. `db/reset.ts`: creates the database if missing (connects to `…/postgres`), drops and recreates schema `public`, runs migrations (used by e2e and local dev only; refuses when `NODE_ENV=production`).
- `db/schema/app.ts`: `app_settings (key text primary key, value jsonb not null, updated_at timestamptz default now())`. First migration `0000_p0-02_app_settings.sql` generated by `pnpm db:generate` and committed.
- `main.ts`: parses the mode argument, loads config, creates db when `DATABASE_URL` is set, `app.listen({ port, host })`, handles SIGTERM.

### 1.5 Contracts and web skeleton

`packages/contracts/src/define.ts`:

```ts
import type { z } from 'zod';
export type Scope =
  | { kind: 'public' } | { kind: 'user' } | { kind: 'system' }
  | { kind: 'class'; role: 'student' | 'instructor' | 'any'; grant?: 'manage_members' }
  | { kind: 'course'; role: 'editor' | 'publisher' | 'owner' };
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface RouteContract<P extends z.ZodType = z.ZodType, Q extends z.ZodType = z.ZodType,
  B extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType> {
  method: Method; path: `/api/${string}`; scope: Scope; summary: string;
  params?: P; query?: Q; body?: B; response: R;
  /** Valid example inputs; the isolation matrix (ADR-0002, P1-01) replays every contract with them. */
  examples: { params?: z.input<P>; query?: z.input<Q>; body?: z.input<B> };
}
export function defineRoute<P extends z.ZodType, Q extends z.ZodType, B extends z.ZodType, R extends z.ZodType>(
  c: RouteContract<P, Q, B, R>): RouteContract<P, Q, B, R> { return c; }
export type ResponseOf<C> = C extends RouteContract<z.ZodType, z.ZodType, z.ZodType, infer R> ? z.output<R> : never;
```

`routes/health.ts` defines the health contract (`scope: { kind: 'public' }`, `examples: {}`). `define.test.ts` checks that a contract without `scope` is a type error (`// @ts-expect-error`) and that `response.parse` rejects a wrong shape.

`apps/web/src/api/client.ts`: `call(contract, { params, query, body })` fills `:param` placeholders, appends a query string, `fetch`es with `credentials: 'same-origin'` and JSON body, throws `ApiError(status, body)` on non-2xx, and in `import.meta.env.DEV` validates the response with `contract.response.parse`. `useApi(contract, args)` wraps it in `useQuery` with key `[contract.path, args]`.

`main.tsx` imports `@parallax/ui/tokens.css` then `./styles/global.css`, creates the router from `routeTree.gen.ts`, and renders `RouterProvider` inside `QueryClientProvider`. `routes/__root.tsx` renders `<GlobalBar />` and `<Outlet />`. `routes/index.tsx` renders the heading "Parallax", and the line `API <status> · database <db>` from `useApi(health)`.

`GlobalBar.tsx` reproduces the wireframe's `.pc-top`: brand link "Parallax", divider, links **Courses** and **Topics** (plain `<a href="/">` in Phase 0 so the component test needs no router; P1-09 switches them to router `Link`s), a `<nav aria-label="Neighbouring topics">` placeholder on the right; CSS in `GlobalBar.module.css` ported from `#parallax-study .pc-top`, `.pc-brand`, `.pc-top-left`, `.pc-topic-nav`, including the ≤ 540 px rules. `global.css` ports the base rules from the wireframe root: `body { margin:0; background:var(--pc-paper); color:var(--pc-ink); font: var(--pc-text-ui); }`, `*, *::before, *::after { box-sizing: border-box }`, `::selection`, base `button`/`input`/`textarea`/`select` (`font: inherit; color: inherit`), `h1–h3` (title/section/subsection tokens), `[hidden]`, `@media (prefers-reduced-motion: reduce)`, `@media (pointer: coarse)` 44 px targets.

### 1.6 Design-token file `packages/ui/src/tokens.css`

Copied from DESIGN.md frontmatter; `tokens.test.ts` parses the frontmatter with `yaml` and asserts each `colors.*`, `rounded.*`, `spacing.*` and `typography.*` (weight/size/line-height) value is present under the corresponding custom property (whitespace-insensitive).

```css
/* Parallax design tokens. Source of truth: DESIGN.md frontmatter. tokens.test.ts fails on drift. */
:root {
  color-scheme: light dark;
  /* colors — light first, dark second */
  --pc-paper: light-dark(#ffffff, #15171a);
  --pc-sheet: light-dark(#ffffff, #1b1e23);
  --pc-ink: light-dark(#202124, #eef0f3);
  --pc-muted: light-dark(#60646c, #afb5bf);
  --pc-rule: light-dark(#d9dce1, #3b4048);
  --pc-accent-ink: light-dark(#ffffff, #202124);
  --pc-highlight: light-dark(#f7edb1, #534a20);
  --pc-soft: light-dark(#f1f2f4, #292d34);
  --pc-secondary: light-dark(#f6f7f8, #1b1e23);
  --pc-success: light-dark(#315747, #a9cebc);
  --pc-accent: var(--pc-ink); /* alias by rule; never a second colour */
  /* typography */
  --pc-font-sans: "Segoe UI", Arial, Helvetica, sans-serif;
  --pc-font-mono: ui-monospace, Consolas, monospace;
  --pc-font-math: Georgia, "Times New Roman", serif;
  --pc-text-title: 600 28px/1.25 var(--pc-font-sans);
  --pc-text-section: 600 26px/1.25 var(--pc-font-sans);
  --pc-text-subsection: 600 20px/1.25 var(--pc-font-sans);
  --pc-text-body: 400 18px/1.65 var(--pc-font-sans);
  --pc-text-ui: 400 14px/1.5 var(--pc-font-sans);
  --pc-text-field: 400 16px/1.5 var(--pc-font-sans);
  --pc-text-label: 400 12px/1.5 var(--pc-font-sans);
  --pc-text-code: 400 14px/1.75 var(--pc-font-mono);
  --pc-text-code-editor: 400 16px/1.75 var(--pc-font-mono);
  --pc-tracking-title: -0.02em;
  --pc-tracking-subsection: -0.01em;
  /* rounded */
  --pc-radius-control: 4px; --pc-radius-passage-tools: 5px; --pc-radius-note: 6px;
  --pc-radius-card: 8px; --pc-radius-filter: 18px; --pc-radius-search: 20px;
  --pc-radius-primary: 24px; --pc-radius-choice: 28px; --pc-radius-square: 0;
  /* spacing */
  --pc-space-4: 4px; --pc-space-8: 8px; --pc-space-12: 12px; --pc-space-16: 16px;
  --pc-space-20: 20px; --pc-space-24: 24px; --pc-space-28: 28px; --pc-space-32: 32px;
  --pc-space-40: 40px; --pc-space-48: 48px; --pc-space-56: 56px;
  /* layout measures, spec §5 */
  --pc-reading-width: 720px; --pc-reading-size: 18px; --pc-notes-width: 280px;
  --pc-notes-gap: 56px; --pc-stage-inset: 40px; --pc-shell-max: 1600px;
}
```

### 1.7 Tests, database and e2e harness

- **Unit**: `packages/contracts/src/define.test.ts`; `packages/ui/src/tokens.test.ts`; `apps/server/src/http/register.test.ts` (building an app with a hand-registered `/api/x` route without scope throws; with `registerRoute` it boots and validates params).
- **Component**: `GlobalBar.test.tsx` renders the bar and asserts the brand text, the `Courses`/`Topics` links and the `Neighbouring topics` navigation landmark.
- **Integration**: `global-setup.ts` connects to `DATABASE_URL`, sweeps `parallax_test_*` databases older than an hour (left by killed runs), creates the per-run template `parallax_test_<epoch-seconds>_<hex>_template`, runs migrations into it, provides the prefix to workers (vitest `provide`/`inject`) and, in teardown, drops only that run's databases. `db.ts` exports `createTestDatabase()` → `CREATE DATABASE <prefix><hex> TEMPLATE <prefix>template`, returns `{ url, db, drop }`. `health.itest.ts` builds the app against that database and expects `{ status: 'ok', db: 'ok' }` and `GET /api/openapi.json` to list `/api/health`.
- **E2E**: `playwright.config.ts` — `testDir tests`, `testMatch /\.e2e\.ts$/`, `timeout 30s`, `retries CI ? 1 : 0`, `workers CI ? 2 : undefined`, reporters `list` (+ `html` never-open in CI), `use.baseURL http://127.0.0.1:3100`, viewport 1440 × 900, project `chromium` only, `trace retain-on-failure`, `globalSetup ./global-setup.ts` (runs `pnpm --filter @parallax/server db:reset` with `DATABASE_URL = E2E_DATABASE_URL ?? postgres://parallax:parallax@127.0.0.1:54329/parallax_e2e`), `webServer { command: 'pnpm --filter @parallax/server start', url: 'http://127.0.0.1:3100/api/health', reuseExistingServer: !CI, env: { PORT: 3100, HOST: 127.0.0.1, NODE_ENV: test, STATIC_DIR: <abs path apps/web/dist>, DATABASE_URL } }`. `smoke.e2e.ts`: `test('P0 shell renders through API and database')` opens `/`, expects heading "Parallax", text `API ok · database ok`, body background `rgb(255, 255, 255)` under `colorScheme: 'light'`, and no axe violations.
- **Go**: `version_test.go` asserts `version.String()` is non-empty; CI builds for linux/amd64, linux/arm64, darwin/amd64, darwin/arm64, windows/amd64.

`scripts/pg-local.sh` (validated in this container): data dir `${PARALLAX_PG_DIR:-/tmp/parallax-pg}`, port 54329, user `parallax`, `--auth=trust`. When running as root (cloud sessions), the script `chown`s the directory to `postgres` and runs `initdb`/`pg_ctl`/`createdb` via `runuser -u postgres --`; otherwise it runs them directly. `start` prints `DATABASE_URL=postgres://parallax:parallax@127.0.0.1:54329/parallax` (same URL as compose, so `.env.example` works with both). `initdb` refuses to run as root; the script must not try.

`scripts/check-scenarios.ts`: greps `**/*.{test,itest,e2e}.{ts,tsx}` and `connector/**/*_test.go` for `\bA(0[1-9]|[12][0-9]|3[0-6])\b` in test titles, prints a table scenario → files; exits non-zero only for IDs listed in `docs/delivery/done/*.txt` (§6) that have no test.

### 1.8 Compose and container image

`infra/compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16.15
    environment: { POSTGRES_USER: parallax, POSTGRES_PASSWORD: parallax, POSTGRES_DB: parallax }
    ports: ["54329:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U parallax"], interval: 5s, timeout: 5s, retries: 10 }
  mailpit:                       # optional inbox UI; the app defaults to the file transport
    image: axllent/mailpit:v1.31.3
    profiles: [mail]
    ports: ["8025:8025", "1025:1025"]
volumes: { pgdata: {} }
```

P1-06 adds `garage` (`dxflrs/garage:v2.4.1`, profile `s3`); P3-11 adds `sshd-jupyter` and `jump`.

`infra/docker/server.Dockerfile`: `FROM node:22.23.3-bookworm-slim`, `corepack enable`, copy manifests (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, every workspace `package.json`), `pnpm install --frozen-lockfile`, copy the rest, `pnpm --filter @parallax/web build`, `ENV NODE_ENV=production STATIC_DIR=/app/apps/web/dist HOST=0.0.0.0 PORT=3000`, `USER node`, `CMD ["pnpm","--filter","@parallax/server","start"]`. `.dockerignore`: `**/node_modules`, `.local`, `.git`, `docs`, `e2e/playwright-report`.

### 1.9 GitHub Actions `ci.yml`

The repository is private, so Actions minutes are metered per job: keep the job count low and do not duplicate setup. Trigger `pull_request` and `workflow_dispatch` only (no `push` to `main`: `pull_request` runs already test the PR merged with its base, and the orchestrator merges only green PRs); `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`; every job `runs-on: ubuntu-24.04`, `timeout-minutes: 10` (the `runner` job added by P3-14 builds a Docker image and keeps `timeout-minutes: 15`). Shared setup steps: `actions/checkout@v5`, `pnpm/action-setup@v4` (no `version`; reads `packageManager`), `actions/setup-node@v5` with `node-version-file: .node-version` and `cache: pnpm`, `pnpm install --frozen-lockfile`. (Major tags could not be verified from the sandbox: api.github.com is blocked there. Use major tags; keeping them current by Dependabot for `github-actions` is a repository setting deferred to the owner, §7, and `.github/dependabot.yml` is not part of any item.)

| job | after setup |
| --- | --- |
| `check` | `pnpm lint`, `pnpm typecheck`, `pnpm test` (unit + component); from P0-03 also `pnpm scenarios`, `actions/setup-go@v6` with `go-version-file: connector/go.mod`, `cache-dependency-path: connector/go.sum`, and in `connector/`: `test -z "$(gofmt -l .)"`, `go vet ./...`, `go test ./...`, and a build loop over the five GOOS/GOARCH pairs |
| `integration` | service `postgres:16.15` (env as compose, port `54329:5432`, `pg_isready` health options); `DATABASE_URL=postgres://parallax:parallax@127.0.0.1:54329/parallax`; `pnpm db:migrate`; `pnpm test:integration` |
| `e2e` | same service; `pnpm build`; `actions/cache@v4` on `~/.cache/ms-playwright` keyed by the Playwright version; `pnpm exec playwright install --with-deps chromium`; `pnpm test:e2e`; `actions/upload-artifact@v4` of `e2e/playwright-report` when failed |

`.github/workflows/image.yml` (separate workflow so it runs only when needed): triggers `pull_request` and `workflow_dispatch` with `paths: [infra/docker/**, .dockerignore, package.json, pnpm-lock.yaml, pnpm-workspace.yaml, apps/*/package.json, packages/*/package.json]`; one job `image`: `docker/setup-buildx-action@v3`, `docker/build-push-action@v6` with `push: false`, `file: infra/docker/server.Dockerfile`, `cache-from/to: type=gha`.

`ci.yml` never uses `paths`/`paths-ignore`: the merge rule needs at least one check run on every PR head, including documentation-only PRs. Pushes cost minutes: implementers push once per review round, after `pnpm check` and the touched integration/e2e tests pass locally.

The three jobs above are the Phase 0 set. P3-14 adds a fourth, `runner`, which P3-13 extends (`ci.yml`, `timeout-minutes: 15` because it builds a Docker image); the table is not extended for it, and the plan text and `ci.yml` agree on 15 for that job.

Scheduled workflows added by later items (load test, backup/restore, full connector matrix) run **weekly**, not nightly, to stay within the Actions allowance.

The PR template already exists (`.github/pull_request_template.md`); do not replace it.

### 1.10 Phase 0 items

**P0-01 · Workspace, contracts, server and web skeleton, unit/component tests, CI check** — Scope: everything in §1.1 except `apps/server/src/db/*`, `drizzle/`, `test/integration`, `e2e/`, `connector/`, `infra/`, `image.yml`; `GET /api/health` returns `db: 'skipped'`; CI job `check` (lint, typecheck, unit + component) green. Also a SessionStart hook (use the `session-start-hook` skill): `.claude/settings.json` (which already exists: add a `hooks` key and keep its `permissions` unchanged) runs `scripts/session-start.sh`, which in remote sessions (`CLAUDE_CODE_REMOTE=true`) enables corepack and runs `pnpm install --frozen-lockfile`, idempotently and quietly. Fill in the Commands section of `CLAUDE.md`. Spec: §6, §5 (global bar). Scenarios: none. Depends on: —. Model: sonnet. Security: no. Size: M (config-heavy; lockfile and `routeTree.gen.ts` excluded).

**P0-02 · Postgres, migrations, integration harness, compose, pg-local, CI integration** — Scope: `db/*`, `app_settings` migration, health reports `db: 'ok'`, template-clone integration harness with `health.itest.ts`, `infra/compose.yml`, `scripts/pg-local.sh`, `.env.example`, CI job `integration`. Extend `scripts/session-start.sh` to start the local Postgres (`pnpm db:local start`, skipped if already running) and export `DATABASE_URL` through `$CLAUDE_ENV_FILE`, so every session can run integration tests. Spec: §13. Scenarios: none. Depends on: P0-01. Model: sonnet. Security: no. Size: M.

**P0-03 · Playwright e2e, Go connector stub, server image, CI e2e/go/image** — Scope: `e2e/` with `smoke.e2e.ts` and axe; `connector/` stub with version test and five-target build; `infra/docker/server.Dockerfile` + `.dockerignore`; `scripts/check-scenarios.ts`; CI job `e2e`, Go steps in `check`, and `image.yml`. Spec: §14 (a11y baseline). Scenarios: none. Depends on: P0-02. Model: sonnet. Security: no. Size: M.

## 2. Phase 1 — identity, membership, immutable releases, reading shell

Parallel tracks once P1-01 merges: **auth** (P1-02 → P1-03), **content** (P1-04 → P1-04a / P1-05 / P1-06 / P1-07 → P1-08), **web** (P1-09 → P1-10, P1-11 → P1-12, P1-13). Authoring (P1-14 → P1-15) and states (P1-16) close the phase.

### P1-01 · Identity, membership schema, scope resolver, isolation matrix
- Scope: tables `users` (incl. `kind` user|preview, `owner_user_id`), `auth_sessions`, `signin_tokens`, `courses`, `course_memberships` (owner/editor/publisher), `classes`, `class_memberships` (role, `manage_members`, `is_preview`), `class_invites` (enrolment codes, instructor invitations, expiry, capacity), `audit_events`. Scope resolver per ADR-0002 (404 for non-members, 403 for wrong role/grant, `requireRecentAuth`), branded `ClassScope`/`CourseScope`, `db/scoped.ts` registry + introspection test, `test/fixtures/world.ts`, isolation-matrix `itest` over all contracts with `examples`, `GET /api/me` (user scope), `GET /api/classes/:classId` (class any) as first scoped routes.
- Spec: §3, §13. ADR-0002. Scenarios: A01, A02, A21 (API level). Depends on: P0-03. Model: opus. Security: yes. Size: M.
- Touches: `db/schema/{users,memberships,audit}.ts`, `auth/scope.ts`, `http/register.ts`, `packages/contracts/src/define.ts`, `test/fixtures/world.ts`, `test/integration/isolation-matrix.itest.ts`.

### P1-02 · Email sign-in links and sessions
- Scope: `POST /api/auth/link` (public, rate-limited, always 202), `file` and `smtp` mail transports, `GET /api/auth/verify?token` (single use, 15-min expiry, sets HttpOnly SameSite=Lax session cookie, `auth_time`, redirects to the preserved destination, rejects open redirects), `POST /api/auth/signout`, session rotation on sign-in, `IdentityProvider` interface with the email provider as the only implementation, `@fastify/cookie`, `@fastify/rate-limit`, `@fastify/helmet` baseline, `SESSION_SECRET` config.
- Spec: §3. Scenarios: A01 (sign-in route does not grant role). Depends on: P1-01. Model: opus. Security: yes. Size: M.
- Touches: `auth/*`, `mail/*`, `http/routes/auth.routes.ts`, `config.ts`.

### P1-03 · Enrolment codes, invitations and membership management
- Scope: create class (course owner), enrolment code join (`POST /api/join`), invite instructor (requires owner or `manage_members`; grants editor course membership), grant/revoke `publisher`/`manage_members`, remove member, expired/full invite errors with cause, all recorded in `audit_events`, sensitive changes require recent auth. `TEST_ROUTES=1` fixture routes (`/api/test/world`, `/api/test/signin-as`) refused otherwise, for e2e.
- Spec: §3, §4 (join, invite errors). Scenarios: A01, A02 (instructor invitation cannot come from a code). Depends on: P1-02. Model: opus. Security: yes. Size: M.

### P1-04 · Content schema, storage interface, immutability
- Scope: tables per ADR-0003 (`topics`, `resources`, `resource_revisions`, `course_releases`, `release_topics`, `release_resources`, `class_release_history`, `study_positions`, `storage_objects`), immutability trigger, optimistic `revision` columns, `Storage` interface with `fs` adapter (content-addressed keys, streaming). Draft CRUD moved to P1-04a to keep the PR within size.
- Spec: §12, §13. ADR-0003. Scenarios: A16 (revision pinning at the data level), A26 (draft changes never reach a class's adopted release, data level). Depends on: P1-01. Model: opus. Security: no. Size: M.
- Touches: `db/schema/{content,releases,storage}.ts`, `storage/*`.

### P1-04a · Draft editing API with revision conflicts
- Scope: draft CRUD contracts and routes for topics and resources (course `editor` scope): list drafts, create/update topic, create/get/update resource; every mutation sends `expectedRevision` and a mismatch returns 409 with the server copy (contracts declare the 409 body); a content change inserts a `resource_revisions` row and moves `head_revision_id`, unchanged content (same `content_hash`) keeps the head; archive/restore instead of delete. No migration.
- Spec: §12, §13. ADR-0003. Scenarios: A26 (class members without a course grant get 404 on draft routes; editing drafts through the API never changes the adopted release). Depends on: P1-04. Model: opus. Security: no. Size: M.
- Touches: `db/content/drafts.ts`, `contracts/routes/drafts.ts`, `http/routes/drafts.routes.ts`, `packages/contracts/src/define.ts` (error bodies), `http/register.ts`.

### P1-05 · Publish release and class adoption
- Scope: validation report, `POST /api/courses/:courseId/releases` (publisher), snapshot copy, `GET /api/classes/:classId/release` (class any; the only content read path for students), adoption `POST /api/classes/:classId/adopt` (instructor) with diff (added/removed/changed, counts of affected annotations and assignments, computed even before those tables exist through a pluggable `affectedBy` registry), history, audit. Fixture world publishes v1 and adopts it in classes A and B.
- Spec: §12, §13. Scenarios: A16, A26. Depends on: P1-04. Model: opus. Security: no. Size: M.

### P1-06 · Content origin, signed content tokens, S3 adapter
- Scope: `CONTENT_HOST`/`APP_HOST` config; `/content/:token` streaming route served only on the content host (cookies ignored, strict CSP `sandbox`, `Content-Disposition` for downloads); HMAC token minting from scoped routes with prefix check; `GET /api/classes/:classId/resources/:revisionId/objects/:key` mints tokens (class any, visibility checked); `s3` adapter (@aws-sdk/client-s3) with Garage in compose (profile `s3`) and CI integration job; Playwright `webServer` switches to `HOST=0.0.0.0` with app `127.0.0.1` and content `localhost`.
- Spec: §2, §13. ADR-0002. Scenarios: A01 (download denied), A21 (private media). Depends on: P1-04. Model: opus. Security: yes. Size: M.
- Touches: `http/content.ts`, `storage/s3.ts`, `infra/compose.yml`, `ci.yml` (integration job), `e2e/playwright.config.ts`.

### P1-07 · Jobs: pg-boss, scoped jobs, worker mode
- Scope: `db/jobs/boss.ts` (pg-boss on the app pool), `runScopedJob` wrapper (payload `{ actorId, scope }`, re-resolution, refusal without scope), `main.ts worker` mode, job status table view for resources (`derived.status`), integration test with a no-op scoped job, compose/CI unchanged (pg-boss lives in Postgres). Foundation for the anchor-mapping and execution jobs.
- Spec: §13. ADR-0002. Scenarios: none. Depends on: P1-04. Model: opus. Security: yes. Size: S.

### P1-08 · Reading ingestion pipeline
- Scope: job `reading.ingest` for Markdown and HTML uploads: unified pipeline (remark-parse, remark-math, remark-rehype, rehype-katex, rehype-highlight, rehype-sanitize with a schema allowing KaTeX/figure/table markup, rehype-stringify), stable `blockId` assignment and `block_map` (ADR-0003), figure ids, citation footnotes, code blocks, image references rewritten to content-token URLs at read time, `derived.status` retry; PDF readings register page count and per-page text (pdfjs-dist in Node) for a11y and anchors.
- Spec: §8, §13. ADR-0003. Scenarios: A06 (block ids stable across an edit; unit fixtures). Depends on: P1-07. Model: opus. Security: yes. Size: M.

### P1-09 · Web shell, routing, sign-in page, session state
- Scope: file routes `/signin`, `/courses`, `/classes/$classId/topics`, `/classes/$classId/topics/$topicId/$tab`, `/courses/$courseId/edit/$topicId`, `/classes/$classId/review` (placeholders where later items fill in), `useSession()` from `/api/me`, redirect to `/signin?next=` with destination preserved, sign-in page (student/instructor entrances, email field, "link sent" state, expired-link state), tab row component with `role=tablist`, arrow keys, `aria-selected`, underline; global bar links live; CSS modules ported from wireframe `.pc-tabs`, `.pc-index`, sign-in.
- Spec: §2, §3, §5. Scenarios: A01 (student on instructor entrance sees explanation, e2e), A02 (context switch UI), A19 (initial 320 px check for shell). Depends on: P1-02. Model: sonnet. Security: no. Size: M.

### P1-10 · Course selection page
- Scope: `GET /api/courses` (user scope: enrolled classes and teaching memberships with resume location and reviewed counts placeholder), course cards per wireframe (mark, title, topic count, term, progress line, reviewed count text, Resume, Class review for instructors), All/In progress/Archived filters, title search, Join a class dialog using P1-03, empty account state, class chooser for multiple enrolments, Create course.
- Spec: §4. Scenarios: A02 (each context lists only its permissions, e2e). Depends on: P1-09, P1-03, P1-05. Model: sonnet. Security: no. Size: M.

### P1-11 · Topic index and topic heading
- Scope: `GET /api/classes/:classId/topics` from the adopted release (availability, schedule/prerequisite locks, estimated time, status), syllabus table with five presence columns, legend, current row, Resume, footer reviewed count; topic heading (title, objective, course, position, time, cohort, instructor) and previous/next topic controls with lock reasons; first-visit tab rule (Slides if present, else first populated).
- Spec: §4, §5, §14 (locked). Scenarios: A02 (cohort visible), A03 (navigation path, partial). Depends on: P1-09, P1-05. Model: sonnet. Security: no. Size: M.

### P1-12 · Reading tab: native and PDF readers, resource picker, study positions
- Scope: native reading render of ingested HTML inside the reading measure (KaTeX CSS, code), PDF reader with pdfjs (fit-width, page controls, page indicator, text layer), resource picker for multiple readings, `PUT /api/classes/:classId/positions` upsert (tab, resource, block/page + offset), restore on load and on Back/Forward (router search state), empty category state ("No reading has been added" / Add reading for instructors).
- Spec: §5, §8, §14. Scenarios: A03 (position survives tab changes and reload; note part in P2-06). Depends on: P1-08, P1-11, P1-06. Model: sonnet. Security: no. Size: M.

### P1-13 · Focus, Full screen and keyboard
- Scope: Focus (hides bar/heading/tabs, keeps toolbar with Exit focus), Full screen via Fullscreen API with fallback notice, `F` shortcut ignoring editable fields and modifiers, Escape rules, state preserved across toggles, focus restoration on exit.
- Spec: §5 "Focus and full screen". Scenarios: A04 (Escape restores layout; slide part in P2-02). Depends on: P1-11. Model: sonnet. Security: no. Size: S.

### P1-14 · Authoring: course creation, topic draft editor, reading upload
- Scope: create course (owner membership), topic editor (title, objective, order, prerequisites, completion rule, estimated time), resource list per tab with Add reading (Markdown/HTML/PDF upload via `@fastify/multipart` with size/type limits, content-addressed storage, ingestion job trigger and status), accessible-alternative field, autosave with `expectedRevision` and conflict view, Publish release button with validation report display, "Class A uses release 1.2" side panel.
- Spec: §12. Scenarios: A26 (partial: editing never touches the class release), A16 (publish creates a new version). Depends on: P1-04a, P1-06, P1-08, P1-09. Model: sonnet. Security: yes. Size: M.

### P1-15 · Preview as student and draft isolation
- Scope: preview principal creation (ADR-0002), `POST /api/courses/:courseId/preview` returning a preview session bound to a draft snapshot, topic workspace rendering in preview with an "Exit draft preview" banner returning to the editor, preview writes isolated, review/export exclusion hook.
- Spec: §3, §12. Scenarios: A26. Depends on: P1-14, P1-05. Model: opus. Security: yes. Size: S.

### P1-16 · Loading, empty, locked, unavailable and revoked states
- Scope: stable title/controls with in-stage loading indicator, locked assignment/topic reasons with time zone, unpublished/foreign link page that discloses nothing, permission-revoked handling (stop reads/writes, explain, purge cached classmate data from Query cache), offline banner for loaded readings, save-failure retry pattern component.
- Spec: §2, §14. Scenarios: A01 (link to unpublished material, e2e). Depends on: P1-12. Model: sonnet. Security: no. Size: S.

### Follow-up items of Phase 1 (suffixed IDs)

Work found while delivering Phase 1 was filed as suffixed items. They have no scope entries here: each issue's body is the scope, and the PR that closed it is the record. Issue numbers are `danielriosgarza/PlatosCave` issues.

| Item | Issues |
| --- | --- |
| P1-01a…e (raw-access lint, `db/` moves, data-access follow-ups) | #76, #99, #100, #116, #135, #164, #174, #179 |
| P1-02a…c (sign-in token purge, sign-in hardening, jobs logger) | #81, #87, #118, #165 |
| P1-03a…c (invitation, membership audit and draft-preview scope hardening) | #96, #122, #170 |
| P1-04a (draft editing API; has its own entry above) | #78 |
| P1-06b…e (content origin follow-ups) | #94, #101, #117, #166 |
| P1-07a, b (scoped jobs hardening) | #88, #106 |
| P1-08a, b (ingestion findings, derived-status resolver) | #114, #152 |
| P1-09b (web shell follow-ups, client test collection) | #98, #157 |
| P1-12a…cc (Reading tab e2e, failure states, origin decision, flushed places) | #131, #132, #139, #171, #176, #207 |
| P1-14a…d (course editor, reading processing) | #126, #134, #136, #137 |
| P1-15a (draft preview findings) | #151 |
| P1-16b, c (revocation and cached-session robustness) | #168, #200 |

Audit fix-ups are `P1-AUDn` issues and need no entry.

## 3. Phase 2 — slides, annotations, exercises, static notebooks

Tracks: **slides** (P2-01 → P2-02 → P2-03, P2-09), **annotations** (P2-04 → P2-05, P2-06 → P2-07, P2-08), **exercises** (P2-10 → P2-11, P2-12), **notebooks** (P2-13 → P2-14, P2-15), plus P2-16.

### P2-01 · Deck ingestion job
- Scope: `slides_pdf` resource type: job extracts page count, per-page text and a text-alternative requirement flag, stores `derived`; original download permitted through content tokens; retry on failure; publication validation rejects raster-only decks without an alternative. Foundation for the slide viewer.
- Spec: §7, §12. Scenarios: none. Depends on: P1-08, P1-14. Model: sonnet. Security: no. Size: M.

### P2-02 · Slide viewer
- Scope: stage with 16:9 letterboxing, pdfjs page rendering with range requests (single page load), previous/next, page count, jump index, fit/zoom with return-to-fit, position line, keyboard arrows only when the stage owns focus and focus retained after change, Focus/Full screen integration, last slide remembered per user and deck revision via study positions, notes margin slot (filled by P2-09).
- Spec: §5, §7. Scenarios: A04, A24 (arrow presses; notes binding completed in P2-09). Depends on: P2-01, P1-13. Model: sonnet. Security: no. Size: M.

### P2-03 · Web slides
- Scope: `slides_web` resource: Markdown deck separated by `---`, rendered through the reading pipeline into per-slide HTML with block ids, same viewer controls, authoring textarea in the topic editor.
- Spec: §7. Scenarios: none. Depends on: P2-02. Model: sonnet. Security: yes. Size: S.

### P2-04 · Annotation and discussion schema, API, visibility
- Scope: tables `annotations` (kind highlight|note|sketch, audience private, body/strokes, anchor, resource revision, class), `threads`/`posts` (audience instructor|class, status open|resolved, edited, tombstones, moderation audit), `annotation_placements`; `db/annotations/visibility.ts` used by every read; contracts for create/update/delete/list by resource, autosave `PUT` with revision, share-as-thread explicit action; notifications list stub. Placements also hold thread anchors (exactly one of annotation/thread), and `classes` gains the student edit/delete post policy, so P2-05 and P2-07 need no migration. Anchor zod schemas live in `packages/contracts/src/anchors.ts`; drawings are stored in `figure` anchors and, for page sketches, in `pdf` anchors (`strokes`), as P2-08 expects.
- Spec: §8, §13. ADR-0002/0003. Scenarios: A05 (API), A21 (discussions per class). Depends on: P1-05 (migration chain after P1-04). Model: opus. Security: yes. Size: M.

### P2-05 · Anchor mapping across revisions
- Scope: job `annotations.map` on adoption per ADR-0003 (exact, fuzzy ≥ 0.9, needs_reattachment), PDF page-hash mapping, placement reads by the class's revision, adoption diff now reports affected anchors, instructor "map annotations" list with manual placement endpoint, unit fixtures for reflow-invariant anchors.
- Spec: §7, §8, §12. Scenarios: A06. Depends on: P2-04, P1-05. Model: opus. Security: no. Size: M.

### P2-06 · Reading margin: highlight, note, ask, autosave, drafts
- Scope: arbitrary text-range selection → `text` anchors, Highlight/Note/Ask toolbar adjacent in flow, margin with My notes/Discussion, note editor aligned to its passage (measured after layout/resize), topic notes without anchor, audience selector preserved with unsent drafts across tabs, Saving/Saved/Offline/Could not save states with 1 s debounce and blur, IndexedDB draft store cleared on sign-out, conflict recovery view, marks with counts, click mark ↔ entry.
- Spec: §8, §14. Scenarios: A03 (acknowledged note survives reload), A05 (UI). Depends on: P2-04, P1-12. Model: sonnet. Security: no. Size: M.

### P2-07 · Discussion threads and moderation
- Scope: replies, instructor responses, Open/Resolved with student reopen of own question, edited indicator, delete with tombstone, class policy for student edit/delete, instructor moderation with audit record, link from thread to its passage.
- Spec: §8. Scenarios: A05 (instructor sees only shared question, e2e). Depends on: P2-06. Model: sonnet. Security: no. Size: M.

### P2-08 · Sketch on figures and PDF pages
- Scope: Sketch action on figures and PDF pages, canvas with pen/colour/width/eraser/undo/redo/Done, stylus and touch with `touch-action: none` only while drawing, stroke storage as `figure`/`pdf` anchors with normalised coordinates, required text description, keyboard-only equivalent (description without drawing), export of drawings as SVG for annotation export.
- Spec: §8. Scenarios: A07. Depends on: P2-06. Model: sonnet. Security: no. Size: M.

### P2-09 · Slide notes and discussion
- Scope: margin in the slide viewer keyed by `slide` anchor, private notes per slide, discussion with audience, drafts kept per slide when navigating, notes preserved against old deck revision until mapped.
- Spec: §7. Scenarios: A24. Depends on: P2-02, P2-06. Model: sonnet. Security: no. Size: S.

### P2-10 · Exercise definitions and attempt state machine
- Scope: zod schema `exercise.v1` (steps: numeric with tolerance, single/multiple choice, ordering/matching, text, simulation control with declared observations, code task placeholder), stored in resource revisions; tables `exercise_attempts`, `exercise_events` (check, hint_shown, solution_revealed, step_completed, restart) append-only; API check/hint/solution/complete/restart with server-side validation, seeded randomness, completion state independent|with_hints|solution_shown, empty explanation rejected.
- Spec: §9, §13. Scenarios: A08 (API), A23. Depends on: P2-04 (migration chain). Model: opus. Security: no. Size: M.

### P2-11 · Exercise UI
- Scope: Predict → Inspect → Explain layout with track, options, feedback, hints in sequence, Show solution, simulation control with keyboard equivalents and readout, Explain textarea, completion summary, Start again; `pc-exercise` CSS ported.
- Spec: §9. Scenarios: A08, A23 (e2e). Depends on: P2-10, P1-11. Model: sonnet. Security: no. Size: M.

### P2-12 · Exercise authoring
- Scope: form editor for steps with validation rules, feedback, hints, completion rule, points/hint policy for credit, definition versioning; publication validation for exercises. As built: `exercise.v1` gains optional `credit` (`points`, `hintPolicy`) and grid checks for simulation `initial`/`compare`; the student attempt view carries `credit` so the UI can show points and policy before starting; publication reports `invalid_exercise`; Start again refuses an invalid revision. The completion rule is implicit per kind (a correct check, a saved explanation, every `compare` value checked, or Show solution); an explicit per-step rule was not needed. Credit models the hint policy only; attempts are unlimited practice, and the grid rule lives in `exercise.v1` itself, so a stored revision with an off-grid simulation value no longer opens (nothing is deployed; such data is local or seed data).
- Spec: §9, §12. Scenarios: none. Depends on: P2-10, P1-14. Model: sonnet. Security: no. Size: M.

### P2-13 · Notebook rendering and sandboxed outputs
- Scope: nbformat import validation (zod for nbformat 4.5), continuous renderer (Markdown/KaTeX cells, code with execution counts, text/image/table outputs inline, HTML/JS outputs rendered only inside a sandboxed iframe on the content origin with CSP and no scripts unless explicitly allowed per course), "Stored output · <kernel>" labels vs live state, collapse source/output, outline, Focus, source download.
- Spec: §10.1, §10.7. Scenarios: A09. Depends on: P1-06, P1-12. Model: opus. Security: yes. Size: M.

### P2-14 · Colab route and notebook upload submissions
- Scope: Open in Colab external launch with working-copy instructions and optional launch event, table `notebook_submissions` (versioned, immutable snapshot object, source revision, environment metadata), upload flow with size/type validation and receipt, instructor listing. Its migration also adds the index `signin_tokens_email_created_idx` on `signin_tokens (email, created_at)` and the matching `index()` in `db/schema/users.ts` (carried from P1-02a; it keeps the per-address link cap count cheap; the hourly purge job bounds the table to about a day of links). As built: snapshots are stored under `classes/<classId>/submissions/` (class area, served from the content origin as attachments); a submission is idempotent per `submissionKey` and versions are numbered per student and notebook; the launch event is an `audit_events` row (`notebook.colab_launched`), not a table; environment metadata is what the file declares (`runtime`, `kernel`, `language`, `nbformat`), recorded as a hint, not a verified fact.
- Spec: §10.1, §10.5, §10.7. Scenarios: A10. Depends on: P2-13, P2-10 (migration chain). Model: sonnet. Security: yes. Size: M.

### P2-15 · Shiny embed and result adapter boundary
- Scope: `shiny` resource with approved origin, iframe with title/state/Focus/Full screen/restart/Open externally, blocked-embed detection with external route, `postMessage` handling limited to origin-validated `ready`/`resize`, explicit refusal to accept grades from messages, "Preview · no session" label in fixtures.
- Spec: §10.7. Scenarios: A11. Depends on: P2-13. Model: sonnet. Security: yes. Size: M.

### P2-15a · Shiny address authoring and publication check
- Scope: Split from P2-15, which embeds a `shiny` revision (`content` is `{ url }`) only when its origin is in `SHINY_ORIGINS` but gave instructors no way to enter the address. The Notebooks authoring tab gets an "Add Shiny app" form (title, address, accessible alternative) and the resource editor an address field. The draft API validates `content.url` for `shiny` through `shinyContentProblem` in `packages/contracts` (https, or http on a loopback host; no credentials; 400 otherwise, on create and update). Publication validation adds the warning `unapproved_shiny_origin` when the address is not on `SHINY_ORIGINS`, so an instructor learns before release that students will see "Preview · no session"; the warning does not block.
- Spec: §10.7, §12. Scenarios: none. Depends on: P2-15. Model: sonnet. Security: yes. Size: S.

### P2-16 · Reviewed marks and course progress
- Scope: table `topic_reviews`, mark ungraded material reviewed, completion rule evaluation (reviewed + graded requirements), reviewed counts on cards and syllabus footer, Resume location from positions. As built: `topic_reviews` holds one row per student, class and resource (unmarking deletes it); `GET`/`PUT /api/classes/:classId/topics/:topicId/reviews[/:resourceId]` are student-only. The default rule asks for every ungraded resource the student can open now to be reviewed and every graded one (test, exercise with credit) submitted (decision 15); `submitted:` is met by a notebook submission or a completed exercise attempt, and `test` submissions arrive with P3-15. The review sheet is 404 for a locked or scheduled topic. A topic with nothing to ask, or an unknown requirement, is never complete. Resume from positions was already built in P1-11.
- Spec: §4. Scenarios: none. Depends on: P1-10, P1-11, P2-14 (migration chain). Model: sonnet. Security: no. Size: S.

## 4. Phase 3 — connected notebooks; isolated execution and submission

Tracks: **connector** (P3-01 → server P3-02 → P3-02a → P3-06 → P3-06a → P3-07, P3-08, P3-09 → P3-09a, P3-10; Go P3-03 → P3-03a → P3-04 → P3-04a, P3-05 → P3-05a → P3-05b; P3-11 joins P3-05a and P3-08), **assessment** (P3-12 → P3-14 → P3-13 → P3-16; P3-15 → P3-16 → P3-16a, P3-17, P3-18). Design items are first and refine their follow-ons in this file; the runner items follow [`docs/design/runner.md`](../design/runner.md) and the connector items follow [`docs/design/connector.md`](../design/connector.md).

### P3-01 · Connector detailed design
- Scope: `docs/design/connector.md`: protocol v1 message schemas (JSON Schema files under `connector/protocol/v1/` shared by Go and TS tests), pairing/approval flow, stage checks and error catalogue mapped to §14 causes, lease semantics, path allowlist, network scope rules, managed mode, OS matrix (Linux, macOS, Windows OpenSSH and WSL), MFA policy, CI fixture design; **rewrites P3-02…P3-11 in this plan** with exact endpoints, file layout and test names.
- As built: [`docs/design/connector.md`](../design/connector.md) and the schemas, error catalogue, signing and frame vectors and fixtures in `connector/protocol/v1/`. P3-02…P3-11 below were rewritten by it; the design's size limits split six of them (P3-02a, P3-03a, P3-04a, P3-05a, P3-06a, P3-09a) and added P3-05b (managed mode, not needed for A27–A36). It records the OS matrix, the MFA policy and the deviations from ADR-0005 in §13, §5.3 and §17.
- Spec: §10. ADR-0005. Scenarios: none. Depends on: P2-13. Model: fable. Security: yes. Size: M.

### P3-02 · Server connector registry and pairing
- Scope: per `docs/design/connector.md` §3, §10.2, §10.3. Migration `NNNN_p3-02_connectors.sql` and `apps/server/src/db/schema/connectors.ts` (barrel line in `db/schema/index.ts`) for `connectors` (`owner_user_id` nullable with the mode check), `connector_pairings`, `notebook_connections` and `class_compute_templates` (added to `classScopedTables`); `userOwnedTables` and `forUser(scope: UserScope, table)` in `db/scoped.ts` with the introspection test of `scoped.test.ts`; `db/connectors/pairing.ts` (code generation in Crockford base 32, normalisation, `HMAC-SHA256(HMAC(SESSION_SECRET, 'parallax-pairing-v1'), code)` hash, create and consume, 10-minute expiry, three live codes per person) and `db/connectors/registry.ts` (create pending connector, approve, reject and revoke, rename, list, `revokeUserConnectors(userId)`, expire pending rows at `approve_by`, last seen); `relay/signing.ts` (the byte layouts of design §4.2 for link, poll and unpair, and the check against the stored public key with `crypto.verify`); `relay/links.ts` holding only the `LinkRegistry` interface and an empty implementation (`online` is false until P3-02a); `packages/contracts/src/connector.ts` with the pairing half of the zod mirror (`PairRequest`, `PairResponse`, `SignedRequest`, `PollResponse`, `ErrorBody`) and `connector.test.ts` over `connector/protocol/v1/examples/pairing-*`, `invalid/pairing-*` and `vectors/signing.json`; `packages/contracts/src/routes/connectors.ts` and `http/routes/connectors.routes.ts` serving the endpoints marked P3-02 in design §10.3 (`POST /api/me/connectors/pairings`, `GET /api/me/connectors`, `POST …/:connectorId/approve` with `scope.requireRecentAuth()`, `POST …/revoke`, `PATCH …/:connectorId`, and public `POST /api/connector/v1/pair`, `/pair/poll`, `/unpair`); preview principals get 403; rate limits and audit events of design §10.3 and §10.2; the maintenance job purges used or expired pairings.
- Tests: `apps/server/test/integration/connectors.itest.ts` (pairing happy path through poll; `A33 a foreign connector id is a 404 for approve, revoke, rename and list`; expired, reused and malformed codes answer one body; per-IP failure budget; recent authentication required to approve; preview principal 403; revoke while pending; revoke closes nothing yet but records `revoked_reason`; at most 5 active and 3 pending connectors); `db/connectors/pairing.test.ts`; `relay/signing.test.ts` (reproduces the three signatures of `vectors/signing.json` and rejects a flipped bit, another origin and another label); `db/scoped.test.ts` updated; the isolation matrix covers the new contracts.
- Spec: §10.3, §10.6, §13. ADR-0002, ADR-0005; design §3, §4.2, §10.2, §10.3. Scenarios: A33 (foreign connector/session 404). Depends on: P3-01, P2-16 (migration chain). Model: opus. Security: yes. Size: M (the migration and pairing are one slice; if it exceeds the limit, split off the contracts mirror).
- Touches: `db/schema/connectors.ts`, `db/schema/index.ts`, `drizzle/*`, `db/scoped.ts`, `db/connectors/*`, `relay/signing.ts`, `relay/links.ts`, `http/routes/connectors.routes.ts`, `packages/contracts/src/connector.ts`, `packages/contracts/src/routes/connectors.ts`, `jobs/maintenance.ts`.

### P3-02a · Server connector link
- Scope: per design §4, §10.1, §10.4. `main.ts` mode `relay` (everything `api` serves plus `apps/server/src/http/relay/*.routes.ts`, loaded only in that mode; `pnpm dev` and the e2e server run `relay`); `@fastify/websocket` 11.3.1; `registerRoute` support for contracts that declare `websocket: true` (scope resolved in `preValidation`, so a refusal is the usual HTTP 404/403 before any upgrade; the isolation matrix replays such contracts as a plain `GET`); `http/relay/link.routes.ts` (`GET /api/connector/v1/link`, public scope, subprotocol `parallax.connector.v1`, 10 s to authenticate, 30 attempts a minute per IP); `relay/auth.ts` (challenge: 32 random bytes, 30 s, single use; `ts` window of 120 s; close codes of design §4.6, `pending` and `revoked` told apart, a bad signature and an unknown id both `bad_signature`; `hello` checks: mode equals the row, `minVersion`); `relay/links.ts` real registry (one live link per connector, newest wins with 4409; `Link.request` matched by `requestId` with timeouts, every pending request rejected with `connector_offline` when the link closes; `openStream` with stream-id allocation and `maxStreams`; heartbeat watchdog: 45 s without a heartbeat closes with 4408 and notifies listeners; the connector row re-read every 60 s so a revocation closes a live link; `revokeUserConnectors` closes links); `relay/framing.ts` (frame codec, credit accounting, `limit_exceeded` resets); the link half of `packages/contracts/src/connector.ts` (`LinkServerMessage`, `LinkConnectorMessage`, `validateTarget` with the eight rules of design §4.4, `ERROR_CODES` and `CAUSES` derived from `connector/protocol/v1/errors.json`, close-code constants); `apps/server/test/fixtures/fake-connector.ts` (a TypeScript connector over a real WebSocket: seed-derived key, scripted answers, used by P3-06 and P3-06a); `online` in `GET /api/me/connectors` becomes real; `POST /api/test/connectors/:connectorId/approve` and `…/drop-link` in `test.routes.ts` (only under `TEST_ROUTES=1`).
- Tests: `link-auth.itest.ts` (valid; wrong key, old `ts`, replayed nonce, pending, revoked, wrong mode, unknown id, wrong origin each refused with the right code; revoke closes a live link at once and within 60 s when the notice is lost; a second link replaces the first); `link-heartbeat.itest.ts` (fake time: acknowledgement, 45 s timeout); `framing.test.ts` (every vector of `vectors/frames.json`, window accounting, `limit_exceeded`); `connector.test.ts` extended (every `examples/*.json` parses with the schema its prefix selects; the named `invalid/` files fail, each on its rule; each `rejected/` file passes the schema and fails `validateTarget` on its rule; `ERROR_CODES` equals the keys of `errors.json`); `register.test.ts` for a websocket contract without scope failing at boot.
- Spec: §10.2, §10.6. ADR-0002, ADR-0005; design §4, §10.1, §10.4. Scenarios: none. Depends on: P3-02. Model: opus. Security: yes. Size: M.
- Touches: `main.ts`, `apps/server/package.json`, `app.ts`, `http/register.ts`, `http/relay/link.routes.ts`, `relay/auth.ts`, `relay/links.ts`, `relay/framing.ts`, `packages/contracts/src/connector.ts`, `packages/contracts/src/define.ts`, `http/routes/test.routes.ts`, `apps/server/test/fixtures/fake-connector.ts`.

### P3-03 · Go connector: state, identity, pairing and CLI
- Scope: per design §3, §5.3, §13. `connector/cmd/parallax-connector/main.go` calls `internal/cli`; commands `pair --server URL --code XXXX-XXXX [--name N] [--force]`, `status [--json]`, `unpair [--yes]`, `doctor [--json]`, `version` (flags with the standard `flag` package; `run` arrives in P3-03a); `internal/state` (state directory per OS and `PARALLAX_CONNECTOR_HOME`, `config.json` read and write validated against `state.schema.json#/$defs/Config`, atomic writes, `run.lock`, owner-only permissions: mode 0600 on Unix, an owner-only DACL through `golang.org/x/sys/windows` on Windows); `internal/identity` (Ed25519 key in PKCS #8 PEM, raw-key fingerprint, `SignLink`, `SignPoll`, `SignUnpair` building the byte layouts of design §4.2); `internal/pairing` (HTTP client for `POST /api/connector/v1/pair`, `/pair/poll`, `/unpair`; HTTPS required except loopback hosts; timeouts; `pair` prints the fingerprint, waits for approval by polling, writes `config.json`); `internal/redact` (`Redact(string)` removing token query values and any registered secret, used by every later package); `internal/doctor` (checks: state directory and key permissions, server reachable and TLS valid, clock skew against the `Date` header, `HTTPS_PROXY`, `jupyter` and `jupyter kernelspec list --json`, agent socket or pipe, TTY, WSL detection by `/proc/version`, OS and architecture; ok, warn, fail; exit status); `internal/version` gains `Commit`; `internal/testserver` (an `httptest` server implementing the three pairing endpoints with the real signature checks, reused by later items); `go.mod`: `golang.org/x/crypto v0.48.0`, `golang.org/x/term v0.40.0`.
- Tests: `TestA27_PairingHalf` (pair against the test server, approve it, config written, fingerprint printed equals the one the server stored), `TestPairWaitsForApproval`, `TestPairRefusesExistingIdentity`, `TestPairNormalisesCode`, `TestIdentityKeyMode0600`, `TestFingerprintVector` and `TestSigningVectors` (read `connector/protocol/v1/vectors/signing.json`), `TestStateDirPerOS`, `TestHTTPOnlyForLoopback`, `TestDoctorReports*`, `TestUnpairKeepsNothing`, `TestRedact`, `TestStateFilesMatchSchema`.
- Spec: §10.2–10.3. ADR-0005; design §3, §5.3, §13. Scenarios: A27 (pairing half). Depends on: P3-01. Model: opus. Security: yes. Size: M.
- Touches: `connector/cmd/**`, `connector/internal/{cli,state,identity,pairing,redact,doctor,testserver,version}/**`, `connector/go.mod`, `connector/go.sum`.

### P3-03a · Go connector: protocol codec, link client and release workflow
- Scope: per design §4, §13. `connector/protocol/embed.go` (package `protocol`, `//go:embed v1/*.json v1/examples v1/vectors`); `internal/protocol` (a struct per message of `link.schema.json` with `Decode(text) (Message, error)` and `Encode`, frame codec, `ValidateTarget` with the eight rules of design §4.4, `Catalogue` loaded from `errors.json`); `internal/link` (WebSocket client on `github.com/coder/websocket v1.8.15` honouring `HTTPS_PROXY`; the challenge/auth/`auth_ok`/`hello` handshake with `identity.SignLink`; dispatcher by `t`; stream table with credit-based flow control and the limits of `auth_ok`; heartbeat every `heartbeatSeconds` with three missed acknowledgements closing the link; reconnect with full-jitter backoff 1 s to 60 s, reset after 60 s up; close-code handling of design §4.6); `internal/cli/run.go` (`run [--allow-net CIDR]… [--state-dir DIR]`: takes the lock, writes `runtime.json`, connects, prints link state changes; a `pending` connector retries every 10 s; `revoked` and `bad_signature` stop); `internal/testserver/link.go` (the server side of the handshake for tests, with scripted messages); `.github/workflows/connector-release.yml` (tags `connector-v*`; five binaries with `CGO_ENABLED=0 -trimpath -ldflags "-s -w -X …/version.Version -X …/version.Commit"`; `SHA256SUMS`; unsigned); `go.mod`: `github.com/coder/websocket v1.8.15` and, test only, `github.com/santhosh-tekuri/jsonschema/v6 v6.0.3`.
- Tests: `TestSchemaFixtures` (every file of `examples/` against the schema its prefix selects; `invalid/` must fail, `rejected/` must pass the schema and fail `ValidateTarget` on the rule of the table in design §4.4), `TestFrameVectors`, `TestErrorCodesInCatalogue`, `TestLinkAuthHandshake`, `TestOriginMismatchStops`, `TestReconnectBackoffWithJitter`, `TestRevokedStopsRetrying`, `TestPendingRetriesEvery10s`, `TestHeartbeatMissCloses`, `TestWindowEnforced`, `TestUnknownMessageIsAnsweredNotFatal`, `TestRunWritesRuntimeJSON`; the release workflow is run once from the PR with `workflow_dispatch` and a dry-run flag.
- Spec: §10.2–10.3. ADR-0005; design §4, §13. Scenarios: none. Depends on: P3-03. Model: opus. Security: yes. Size: M.
- Touches: `connector/protocol/embed.go`, `connector/internal/{protocol,link,cli,testserver}/**`, `connector/go.mod`, `connector/go.sum`, `.github/workflows/connector-release.yml`.

### P3-04 · Go connector: network scope, Jupyter proxy and the This-computer target
- Scope: per design §5.1, §6, §7, §8. `internal/netscope` (`Classify(addr)` with the classes of design §8 including unwrapping of IPv4-mapped, NAT64 and 6to4 forms, `Scope` parsed from `--allow-net` and `PARALLAX_ALLOW_NET`, a `Dialer` that resolves, requires every answer to be allowed, dials the first by IP and re-checks the connected address in `Control`); `internal/jupyter` (`allowlist.go`: the table of design §7 as code with the path, query and header rules; `client.go`: HTTP client with no redirects, no proxy, token header injection, response filtering and size caps; `ws.go`: kernel-channel bridge to a link stream; `local.go`: free-port choice, start `jupyter server` or `<python> -m jupyter_server` with the fixed flags of design §6, token through the environment, readiness polling, `redact()` on all output; `list.go`: parse `jupyter server list --json`, loopback listeners only; `kernelspecs.go`: `jupyter kernelspec list --json`); `internal/target` (`Target` interface with `Test(ctx, req, progress)` and `Open(ctx, req)`, and `Local`: stages `workspace`, `runtime`, `notebook_auth`, `kernels`, `ready_to_start` versus `ready` outcomes); `internal/session/manager.go` (in-memory sessions with ownership; handles `test_connection`, `open_session`, `close_session`, `http`, `ws_open` from the link, always answering `error` with a catalogue code on refusal; `session_state` `starting`, `ready`, `failed`, `stopping`, `stopped`; owned versus attached; stop through `POST /api/shutdown` then the pid; leases arrive in P3-04a); `hello.networkScope` filled from the scope; `run --confirm-sessions` and the session log line of design §1; the kernel-id set of design §7; Linux `Pdeathsig` and Windows job-object handling for the child.
- Tests: `TestA33_ForbiddenDestinationsRejected` (a table of at least 40 addresses and encodings: metadata IPv4 and IPv6, mapped forms, decimal and hex hosts, loopback, private ranges with and without `--allow-net`, unspecified, multicast), `TestAddressClassification`, `TestDialRechecksConnectedAddress` (resolver answers a mix of allowed and denied), `TestAllowlist*` (every row accepted; `..`, encoded `..`, double encoding, hidden segments, `token=`, unknown query keys, other methods, `/api/sessions`, `/api/shutdown` refused with `path_not_allowed`), `TestHeadersFiltered`, `TestNoRedirectsFollowed`, `TestTokenNeverInArgvURLOrLog`, `TestRedactsTokenFromJupyterLog`, `TestLocalStartAndStatus` (a stub `jupyter` program in a temporary `PATH`), `TestA27_LocalRunsCellThroughProxy` (an `httptest` fake Jupyter with a kernel WebSocket: the cell's output returns over the link and nothing listens off loopback), `TestTestConnectionLocalStages`, `TestAttachListsLoopbackOnly`, `TestKernelIdsConfinedToSession`, `TestContentsPostBodyRestricted`, `TestConfirmSessionsAsksFirst`, `TestAttachedSessionStopIsNotOwned` (the connector half of `error not_owned`).
- Spec: §10.2, §10.4, §10.6. ADR-0005; design §5.1, §6, §7, §8. Scenarios: A27, A33 (forbidden destination, connector half). Depends on: P3-03a. Model: opus. Security: yes. Size: M.
- Touches: `connector/internal/{netscope,jupyter,target,session}/**`, `connector/internal/cli/run.go`.

### P3-04a · Go connector: leases, sessions file and loss causes
- Scope: per design §5.5, §6 (ownership and exit), §9. `internal/session` gains the lease engine (phases `attached` and `detached`, `presence` and `activity` handling, kernel activity from the heartbeat poll of `GET /api/kernels`, link loss counted as detach, deadlines as wall-clock instants checked every second, stop at expiry with causes `lease_idle` and `lease_grace`, attached sessions closed with `stopped` / `lease_grace` and `owned: false`) with an injectable clock; terminal records (`state: stopped`, `cause`, `stoppedAt`) kept until reported on a live link, the heartbeat `seq 0` that follows `hello` listing every session including those, a 12-hour `hardDeadline` (`max_lifetime`); `sessions.json` (`state.schema.json#/$defs/Sessions`, atomic write at most every 5 s and on every transition, mode 0600, never a secret); start-up sweep of orphans (marker proof, kill only the recorded process); stop on SIGINT/SIGTERM with cause `connector_exit`; `internal/cause` (the rules of design §5.5 over injectable inputs: a 1 s ticker lateness source, an interface snapshot provider with VPN-like name rules per OS, `expectedEnd`, transport and service probes) and `session_state` `disconnected` with `cause` and automatic transport-reconnect scheduling hooks for P3-05a; `heartbeat` carries session phase, lease expiry and kernel states.
- Tests: `TestA32_DisconnectKeepsOwnedUntilGrace`, `TestA32_IdleStopsAfterTimeout`, `TestA32_StopConfirmsTermination` (`stopped` only after the process is gone), `TestA32_AttachedRuntimeIsNeverStopped`, `TestA32_LinkLossCountsAsDetach`, `TestLeaseSurvivesRestart`, `TestBusyKernelDoesNotExtendDetachedGrace`, `TestOrphanSweepKillsOnlyMarkedProcess`, `TestSessionsJSONAtomicAndPrivate`, `TestSessionsFileNeverHoldsSecrets`, `TestA36_CauseClassification` (one subtest per row of design §5.5, fake clock and fake interface snapshots), `TestA36_SleepResumePastDeadlineStops` (expects cause `sleep`), `TestDeadlinePassedWithoutSleepUsesLeaseCause`, `TestRunStopsOwnedSessionsOnSIGTERM`, `TestRevokedLinkStopsOwnedSessions`, `TestStoppedWhileOfflineIsReportedWithItsCause`, `TestFirstHeartbeatListsEverySessionIncludingStopped`.
- Spec: §10.4. ADR-0005; design §5.5, §6, §9. Scenarios: A32, A36 (connector half). Depends on: P3-04. Model: opus. Security: yes. Size: M.
- Touches: `connector/internal/{session,cause}/**`.

### P3-05 · Go connector: SSH dial, host identity, authentication and jump host
- Scope: per design §5.1–5.3, §8. `internal/sshtarget`: `dial.go` (netscope-guarded TCP, SSH handshake, jump host as a `direct-tcpip` channel of the first client, the same checks on each hop), `knownhosts.go` (own `known_hosts` via `golang.org/x/crypto/ssh/knownhosts`, comments kept, `# replaced` history, algorithm restriction), `hostkey.go` (the eight-row decision table of design §5.2 as a pure function plus the callback), `auth.go` (agent, then key file with optional certificate, then `keyboard-interactive` second factor; passphrase and prompts read from the controlling terminal with `golang.org/x/term`, never when `features.tty` is false; the three-attempt and 120 s limits; no password or GSSAPI), `agent_unix.go` and `agent_windows.go` (`SSH_AUTH_SOCK`; the OpenSSH pipe opened as a file), `forward.go` (the `forwarding` stage: a `direct-tcpip` open to `127.0.0.1` read as `forwarding_denied` versus connect-failed), `stages.go` (`reachability`, `host_identity`, `ssh_auth`, `workspace`, `forwarding` with blocked-stage skipping and the deadlines of design §5.1, each covering every hop of its stage; the `host_identity` report shape of design §5.2, every passed hop in `data.hops`; a `running` `ssh_auth` `test_progress` with `terminalPrompt` when a terminal prompt starts); `internal/sshtest` (an in-process `x/crypto/ssh` server: host keys, rekeying, publickey, `keyboard-interactive`, `direct-tcpip` allow or deny, a jump route, exec of `test -d`/`test -w`/`cd -P`).
- Tests: `TestA30_HostKeyDecisionTable` (the eight rows), `TestA30_ChangedKeyIsAHardStop` (no retry, record untouched), `TestA30_ReplaceNeedsConfirmationAndKeepsHistory`, `TestHostKeyAlgorithmRestriction`, `TestServerRecordWithoutLocalEntryTrusts`, `TestJumpRouting`, `TestJumpHopKeyChecked`, `TestA28_StagesOverJump`, `TestAuthOrderAgentThenKey`, `TestCertificateUsed`, `TestPassphraseFromTerminalOnly`, `TestMFAKeyboardInteractive`, `TestMFANoTerminal`, `TestMFAWrongThreeTimes`, `TestUnsupportedMethodsReported`, `TestA29_ForwardingDeniedStage`, `TestStagesBlockedAfterFailure`, `TestWorkspaceStagesCreateNothing`, `TestSSHDialUsesNetScope`, `TestHostIdentityReportsPassedHops`, `TestTerminalPromptSendsRunningProgress`, `TestStageDeadlinesCoverEveryHop`.
- Spec: §10.2, §10.3. ADR-0005; design §5.1–5.3, §8. Scenarios: A28, A29 (forwarding and authentication stages), A30. Depends on: P3-04. Model: opus. Security: yes. Size: M.
- Touches: `connector/internal/sshtarget/**`, `connector/internal/sshtest/**`, `connector/internal/target/**`, `connector/go.mod`.

### P3-05a · Go connector: remote runtime over SSH
- Scope: per design §5.1 (`runtime`, `notebook_auth`, `kernels`), §6, §9. `internal/sshtarget`: `template.go` and `shellquote.go` (the fixed start template of design §6, golden-tested, with `shellQuote`), `remote.go` (POSIX check with `uname -s`, interpreter and Jupyter version probe, `jupyter server list --json` and `jupyter kernelspec list --json` by exec, port choice 20000–59999 with up to five retries, start with the token on standard input and the pid line, readiness through the tunnel), `tunnel.go` (the session's fixed `127.0.0.1:<P>` forward and the HTTP and WebSocket bridge reusing P3-04's proxy), `stop.go` (shutdown API, marker-proved `SIGTERM` then `SIGKILL`, `stopped` only once the process is gone), `reconnect.go` (keepalive every 15 s, 45 s loss, the reconnect schedule of design §5.5 feeding `internal/cause`, session back to `ready` when `/api/status` answers), the 120 s reuse of a tested connection by the next `open_session` for the same connection, attach mode (`root_dir` containment, loopback-only, `token_unavailable`), the non-POSIX-host rule (`shell_unsupported` for everything).
- Tests: `TestRemoteStartTemplate` (golden), `TestShellQuoteFuzz`, `TestCommandTemplates` (no variable part outside the validated ones), `TestRemoteTokenOnStdinOnly`, `TestA29_JupyterMissing`, `TestA29_JupyterTooOld`, `TestA29_NotebookAuthRejected`, `TestA29_RemoteExecDenied`, `TestA28_OwnedSessionReady` (in-process SSH server plus an `httptest` Jupyter behind it), `TestA28_AttachNeverStops`, `TestTunnelDestinationFixed`, `TestStopShutdownThenKillWithMarker`, `TestNonPosixHostUnsupported`, `TestA36_SSHLossCausesOverRealTransport` (sleep, timeout, service stopped, expired allocation via `expectedEnd`), `TestSSHReconnectKeepsSession`, `TestTestedConnectionReusedForConnect`, `TestOrphanRemoteSweepNonInteractive`.
- Spec: §10.2, §10.3, §10.4. ADR-0005; design §5, §6, §9. Scenarios: A28, A29 (runtime, notebook authentication and kernel stages), A36 (SSH half). Depends on: P3-05, P3-04a. Model: opus. Security: yes. Size: M.
- Touches: `connector/internal/sshtarget/**`, `connector/internal/session/**`.

### P3-05b · Go connector: managed mode
- Scope: per design §12. `run --managed` reading only the environment of design §12 (`internal/managed/config.go`, `targets.go`, `keys.go`): refused key-file permissions, empty default scope, loopback and link-local refused at start-up, pinned `known_hosts` only (`host_key_untrusted_managed`), no prompts (`key_passphrase_required` and `mfa_requires_terminal` are final), `kind: 'managed'` targets resolved from `PARALLAX_TARGETS_FILE`, `local` refused with `unsupported_target`, `hello.mode = 'managed'`; the server's `scripts/register-managed-connector.ts` (`pnpm --filter @parallax/server connectors:register-managed`) inserting an `active` managed row and printing its id; a `managed` compose service fragment in `infra/compose.yml` under profile `managed` with a read-only root file system and no database credentials. **Not required for A27–A36**; scheduled after P3-11 and before the pilot (spec §17: who operates managed connectors is an owner decision).
- Tests: `TestManagedRefusesLooseKeyPermissions`, `TestManagedDefaultScopeDeniesAll`, `TestManagedRefusesLoopbackConfig`, `TestManagedUnpinnedHostRefused`, `TestManagedNeverPrompts`, `TestManagedRejectsLocalTarget`, `TestManagedTargetResolution`; `register-managed-connector.test.ts` and an itest that a managed row is invisible to every person's `GET /api/me/connectors`.
- Spec: §10.2, §10.3, §10.6, §17. ADR-0005; design §12. Scenarios: none. Depends on: P3-05a, P3-10, P3-11. Model: opus. Security: yes. Size: M.
- Touches: `connector/internal/managed/**`, `connector/internal/cli/run.go`, `apps/server/src/scripts/register-managed-connector.ts`, `apps/server/package.json`, `infra/compose.yml`.

### P3-06 · Server connections, notebook sessions and Test/Connect
- Scope: per design §10.2–10.4, §10.7, §8. Migration `NNNN_p3-06_notebook_sessions.sql` and `db/schema/notebook-sessions.ts` (barrel line in `db/schema/index.ts`) for `notebook_sessions`, `cell_executions`, `notebook_working_copies`, `notebook_working_copy_revisions`, `file_transfers` and `notebook_submission_files`, plus whichever of `working_copy_id`, `working_copy_revision`, `session_id`, `environment` the merged P2-14 `notebook_submissions` lacks; all added to `classScopedTables`; `db/connectors/connections.ts` and `db/notebooks/sessions.ts` (data access taking `UserScope` or `ClassScope`, returning the `OwnedConnection` and `OwnedSession` values the relay requires); `relay/netpolicy.ts` (rules 1–2 of design §4.4 plus the connector-reported scope); `relay/jupyter.ts` (the typed operations of design §7, each building the request from validated arguments); `relay/session-state.ts` (`nextSessionState`, the table of design §10.7) and `relay/sessions.ts` (applies connector messages, heartbeat reconciliation and the 45 s `unconfirmed` rule, `close` with `stop`, the leak clean-up, 300 s `starting` timeout (never extended), the clean-up of a late `ready` after `failed`, audit); `relay/tests.ts` (in-memory test runs: `testId`, owner, partial stages, 10-minute expiry, the 300 s `test_timeout`, not extended; a `running` stage with `terminalPrompt` is held as the current stage for the poll); contracts and routes for the endpoints marked P3-06 in design §10.3 (`/api/me/connections…`, `…/test`, `…/tests/:testId`, `/api/classes/:classId/notebook-sessions…`, `…/close` and `…/forget`), the connection routes in `http/routes/connections.routes.ts` and the live ones in `http/relay/`; rate limits and audit events; `relay/` uses the fake connector of P3-02a in every test.
- Tests: `a33-notebook-isolation.itest.ts` (`A33 two classmates on one template cannot read each other's sessions, kernels or files`; `A33 a guessed session id is a 404 even for the class instructor`; `A33 a forbidden forwarding destination is refused at save and at connect`); `a32-close.itest.ts` (`A32 stop of an attached session is refused with not_owned`; `A32 detach keeps the session ready`; `A32 stop is confirmed only when the connector says stopped`; `A36 a session stopped while the link was down gets the connector's cause, not connector_restarted`; `A36 a session is not stopped or cleaned up before the first heartbeat after hello`; `A36 an open_session refused with limit_exceeded fails with that code`; `A36 a failed stop returns to the last state and Forget works from stopping`; `A36 Forget frees a session that cannot be reached so a new one can start`); `connections.itest.ts` (create, rename, host-key clearing on PATCH, archive with `409 in_use`, wrong connector, template class mismatch); `test-connection.itest.ts` (`A30 a changed host key is never stored and a replace needs the stored fingerprint and recent authentication`; progress, `needs_action` then confirmation, replace requires `replacing` equal to `data.expected` of the latest `host_key_changed` result for that host and port (whether or not a fingerprint is stored) and recent authentication; host keys are persisted only from `data.hops` by the rules of design §5.2: a direct target's confirmed first-use key, both hops of a jump route, a jump host confirmed while the target still needs confirmation (stored from the `needs_action` result) and any listed hop whose `host:port` has no record, while a differing record is replaced only by an accepted `replacing` confirmation; a `running` `ssh_auth` report appears in the poll; `test_timeout` after 300 s, not extended by `terminalPrompt`); `session-state.test.ts` (every row of design §10.7); `netpolicy.test.ts`; `jupyter.test.ts` (no operation can produce a path outside the allowlist); `scoped.test.ts` updated; the isolation matrix covers the new contracts.
- Spec: §10.4, §10.6, §13. ADR-0002, ADR-0005; design §8, §10. Scenarios: A32, A33, A36 (Forget), A30 (server half). Depends on: P3-02a, P3-15 (migration chain). Model: opus. Security: yes. Size: M (expect it to split: the migration and connections first, sessions and Test/Connect second).
- Touches: `db/schema/notebook-sessions.ts`, `db/schema/index.ts`, `drizzle/*`, `db/scoped.ts`, `db/connectors/connections.ts`, `db/notebooks/sessions.ts`, `relay/{netpolicy,jupyter,session-state,sessions,tests}.ts`, `http/routes/connections.routes.ts`, `http/relay/*.routes.ts`, `packages/contracts/src/routes/{connections,notebookSessions}.ts`.

### P3-06a · Server browser channel and execution binding
- Scope: per design §10.5, §10.6, §7. `relay/channel.ts` (the browser channel of design §10.5: `GET /api/classes/:classId/notebook-sessions/:sessionId/channels` as a `websocket: true` contract, `Origin` check, scope re-validated every 60 s and on any message naming a resource, closed on revocation or when the session leaves the class), `relay/kernel.ts` (typed kernel operations behind `POST/GET/DELETE …/kernel`, `…/kernel/interrupt`, `…/kernel/restart`: start with a chosen kernelspec, the single long-lived kernel channel stream per kernel opened with the notebook session id as Jupyter's `session_id`, `presence` messages, `activity` messages at most every 10 s), `relay/binding.ts` (the binding, matching, state machine, restart and generation rules, link-loss handling and the post-reconnect kernel query of design §10.6; `client_ref` idempotency; no `execute_request` is ever resent), `relay/buffer.ts` (256 KiB per execution, 8 MiB per session, replay by event sequence, `epoch`), `db/notebooks/executions.ts`, `packages/contracts/src/notebookChannel.ts` (zod for both directions), `GET …/executions?afterSeq=`.
- Tests: `a31-execution-binding.itest.ts` (`A31 a resent execute with the same ref sends one execute_request`; `A31 reconnect asks the kernel and never executes again`; `A31 output with an unknown parent is dropped`; `A31 output from a restarted kernel generation is dropped`; `A31 lost kernel needs an explicit new session`; `A31 an unrecoverable gap is incomplete`; `A31 a failed write leaves the execution unconfirmed`), `restart.itest.ts`, `channel.itest.ts` (origin, scope loss, revocation, `rate_limited`), `buffer.test.ts` (limits, replay, epoch change), `kernel-state.test.ts`, `notebookChannel.test.ts`.
- Spec: §10.4. ADR-0002, ADR-0005; design §7, §10.5, §10.6. Scenarios: A31. Depends on: P3-06. Model: opus. Security: yes. Size: M.
- Touches: `relay/{channel,kernel,binding,buffer}.ts`, `http/relay/{channel,kernel}.routes.ts`, `db/notebooks/executions.ts`, `packages/contracts/src/notebookChannel.ts`, `packages/contracts/src/routes/notebookSessions.ts`.

### P3-07 · Web: Connect computer panel
- Scope: per design §2, §3, §5, §9, §10.3. There is no wireframe for this panel (spec §15): build it from `DESIGN.md` tokens and the existing panel and form styles. `apps/web/src/notebooks/connect/`: `ConnectPanel.tsx` (opened from the notebook toolbar's target label; **This computer**, **SSH host**, **Class computers** once P3-10 lands), `DeviceList.tsx` (this person's connectors: name, OS, version, online, fingerprint, Approve, Reject, Revoke, Rename; first-time instructions with the exact `parallax-connector pair --server … --code …` line and the code with its expiry), `TargetForm.tsx` (fields of spec §10.3: name, connector, host, port, user, jump host, authentication as key path or agent, workspace, runtime start or attach with interpreter and login-shell option, kernel choice), `StageList.tsx` (the eight stages as `test_progress` arrives, polling `GET …/tests/:testId` each second, each failing stage with its catalogue recoveries; `needs_action` shows the fingerprint with **Trust this key**; `host_key_changed` shows both fingerprints, stops, and offers **Replace trusted key** only behind a confirmation that names the host and requires recent authentication; waiting for the connector's terminal, a `running` `ssh_auth` stage with `terminalPrompt`, is shown as such), `ConnectSummary.tsx` (host, account, workspace exact path, start or attach, the lease sentence of design §9, the connector's reachable network), `LossNotice.tsx` (cause text for sleep, VPN, SSH timeout, stopped service, expired allocation, link lost; edits kept; Reconnect, Forget or Choose another target), a warning on HPC login-node hosts that SSH access does not authorise computing there (spec §10.2), `messages.ts` (copy for every code and cause of `errors.json`), `api.ts` (TanStack Query hooks). Statements follow design §5.6: Ready only after the kernel is idle; Connected never from SSH alone; the personal-connection statement that it may reach that person's files with their privileges; no secret field exists.
- Tests: component tests (`ConnectPanel.test.tsx`, `StageList.test.tsx`, `DeviceList.test.tsx`, `LossNotice.test.tsx`): `A29 the failing stage is named and the recovery shown`, `A29 a session never shows Ready after SSH alone`, `A30 a changed host key stops the connection and offers Replace only behind a confirmation`, `A36 a lost session shows its cause, keeps the notebook editable and offers Forget`, `A27 Ready is not shown before the kernel is idle`, `messages.test.ts` (every catalogue code and cause has copy), the host-key-change flow, keyboard path and focus return, a screen-reader status announcement per stage, axe; e2e of the pairing screen is P3-11's.
- Spec: §10.3, §14. DESIGN.md; design §5, §9. Scenarios: A27, A29, A30 (UI), A36 (UI). Depends on: P3-06a. Model: sonnet. Security: no. Size: M.
- Touches: `apps/web/src/notebooks/connect/**`, `apps/web/src/notebooks/NotebookView.tsx`.

### P3-08 · Web: live notebook execution
- Scope: per design §2, §10.5, §10.6, §5.6. `apps/web/src/notebooks/live/`: `LiveNotebook.tsx` (editable cells on CodeMirror 6 with `@codemirror/lang-python`, markdown cells rendered as today), `Toolbar.tsx` (target and kernel state, Run cell, Run all in notebook order stopping on error, Interrupt, a session menu with Restart kernel, Disconnect, Stop session each with its confirmation; resource availability only when the environment reports it), `useChannel.ts` (the WebSocket of design §10.5: `hello` with `resume`, reconnect with backoff, resending an unacknowledged `execute` only with its original `ref`), `executionState.ts` (a reducer over `execution`, `output`, `kernel_state`, `session_state` events), `Outputs.tsx` (streamed output incrementally, truncation label, input prompts bound to their cell, outputs from a previous kernel generation marked, `Unconfirmed` and `Incomplete` labels with a Run again choice and no automatic re-run), connection-lost mode (execution disabled, editing kept, last kernel state shown unconfirmed, cause from P3-07's `messages.ts`), a browser that is offline or a channel that is closed is the same connection-lost mode; an Interrupt that has not returned the kernel to idle after 5 seconds offers Restart kernel with the warning that variables will be lost (spec §10.4); reconnect flow that reattaches by session id and offers a new kernel only when the old one is gone. Live outputs go through the notebook sanitiser and the sandboxed content-origin frame of P2-13 exactly as stored outputs do.
- Tests: component tests: `A27 output returns to the same full-width notebook`, `A31 a dropped socket reattaches and the cell is not run again`, `A31 an incomplete output is labelled and offers Run again`, `A32 Stop session asks for confirmation and Disconnect does not claim the kernel stopped`, `A36 connection lost disables Run and keeps editing`, `Interrupt that does not stop the kernel offers Restart with a warning`, `A09 live HTML output stays in the sandbox`, Run all stops on an error, input prompt belongs to its cell, restart marks old outputs, keyboard path, axe; e2e flows are P3-11's.
- Spec: §10.4, §14. Design §5.6, §10.5, §10.6. Scenarios: A27, A31, A32, A36 (UI), A09 (live output). Depends on: P3-06a, P3-07, P2-13. Model: sonnet. Security: no. Size: M.
- Touches: `apps/web/src/notebooks/live/**`, `apps/web/src/notebooks/NotebookView.tsx`, `apps/web/src/notebooks/NotebooksTab.tsx`.

### P3-09 · Working copies, file transfer and notebook submission (server)
- Scope: per design §11, §10.2. `db/notebooks/workingCopies.ts` (creating the working copy at first Connect, saving revisions with `baseRevision` and `409 revision_conflict` carrying the current copy), `relay/transfers.ts` (copy-in of the declared files with checksum comparison and conflict states; Save to computer; listing confined to the workspace; import creating a new revision after nbformat validation; copy-out of selected files into class storage with the 25 MiB and 200 MiB limits; all through `purpose: 'contents'` requests), the endpoints `GET …/notebook-working-copies/:revisionId`, `PUT …/notebook-working-copies/:id/revisions`, `GET …/notebook-sessions/:sessionId/files`, `POST …/transfers`, `GET …/transfers/:id`, `POST …/submit` with contracts, the submission written through P2-14's service with the selected `done` transfers as `notebook_submission_files` and the session's environment metadata, audit events, with the declared files read from the notebook's own metadata, `metadata.parallax.files: [{ path, resourceId }]`, each naming an existing media resource of the course (no schema change; an authoring form for it is a follow-up issue); nothing in grading material is reachable from a connector or a session.
- Tests: `a34-working-copy.itest.ts` (`A34 saving to Parallax does not claim the remote file was uploaded`; `A34 a conflicting remote revision is detected and not overwritten`; `A34 submission contains only acknowledged selected files`; `A34 kernel memory is not part of a save`), `a35-submission.itest.ts` (`A35 the instructor opens the snapshot without any connector call`; `A35 no hidden test material is sent to a connector`), `transfers.itest.ts` (divergence choices, size limits, path confinement, content-origin attachment), `workingCopies.itest.ts` (stale base revision 409).
- Spec: §10.5. ADR-0002, ADR-0003; design §11. Scenarios: A34, A35. Depends on: P3-06a. Model: opus. Security: yes. Size: M.
- Touches: `db/notebooks/workingCopies.ts`, `relay/transfers.ts`, `http/relay/transfers.routes.ts`, `http/routes/workingCopies.routes.ts`, `packages/contracts/src/routes/{workingCopies,transfers}.ts`.

### P3-09a · Web: files, save and submit
- Scope: per design §11 and spec §10.5. `apps/web/src/notebooks/files/`: the **Saved to Parallax** versus **Save to computer** controls with the exact destination, the copy-in confirmation ("Copy N files to `<path>`") before first execution, the workspace file list limited to the workspace, conflict dialogs (keep theirs, replace, save as a copy), Import, selection of output files to copy out with sizes, **Submit notebook** with the list of what will be frozen (revision, files, environment) and the receipt, and the instructor's snapshot view reusing P2-14's listing with the environment line and file manifest. States: nothing says Saved or Uploaded without an acknowledgement.
- Tests: component tests: `A34 Saved to Parallax appears only after the acknowledgement`, `A34 a conflict offers three choices and overwrites nothing`, `A34 only selected acknowledged files are listed for submission`, `A34 a failed save keeps the draft and offers Retry and a download`, `A35 the instructor view shows the snapshot and no connect action`, keyboard path and focus return, axe.
- Spec: §10.5, §14. Design §11. Scenarios: A34 (UI), A35 (UI). Depends on: P3-09, P3-08. Model: sonnet. Security: no. Size: M.
- Touches: `apps/web/src/notebooks/files/**`, `apps/web/src/notebooks/NotebookView.tsx`.

### P3-10 · Class host templates
- Scope: per design §11 (class host templates), §10.2, §10.3. Routes `GET/POST /api/classes/:classId/compute-templates`, `PATCH/DELETE …/:templateId` (instructors write with recent authentication and the required `host_owner_confirmed` statement; every class member reads), `db/connectors/templates.ts`, creating a connection from a template (`POST /api/me/connections` with `templateId`, the learner's own user and credential reference; a template cannot carry a user, key, token or home directory, and is usable only in its own class, checked at session creation), audit `template.published`, `template.archived`, `template.used`; the web side under `apps/web/src/notebooks/connect/`: the instructor's form and list, and **Class computers** in the panel with the isolation statement (`account`, `container`, `allocation`) in plain words and the personal-connection statement.
- Tests: `template.itest.ts` (`A33 a template carries no credentials and cannot be used in another class`; instructor writes and student reads; confirmation required; students cannot write; audit), `A33 two classmates using one template get separate connections and sessions`, component tests for the form, the isolation statements and the keyboard path.
- Spec: §10.3, §13. Design §11. Scenarios: A33. Depends on: P3-07. Model: opus. Security: yes. Size: M.
- Touches: `db/connectors/templates.ts`, `http/routes/computeTemplates.routes.ts`, `packages/contracts/src/routes/computeTemplates.ts`, `apps/web/src/notebooks/connect/**`.

### P3-11 · Connector CI fixtures and end-to-end
- Scope: per design §15. Compose profile `connector` in `infra/compose.yml`: `sshd-jupyter` (`infra/docker/sshd-jupyter.Dockerfile`: `python:3.12-slim`, `openssh-server`, `jupyter-server==2.21.1`, `ipykernel==7.4.0`, `nbformat==5.11.1`; sshd on port 22 published as `127.0.0.1:2222`, a second instance on 2223 with `AllowTcpForwarding no`; users `student`, `bare`, `locked`; host keys generated at start into a volume) and `jump` (`infra/docker/jump.Dockerfile`, `PermitOpen sshd-jupyter:22`, published `127.0.0.1:2225`); `scripts/connector-fixture-keys.sh`; `connector/internal/fixture/*_test.go` under the build tag `fixture` (TestA28/TestA29/TestA30 against the real sshd); `e2e/tests/connector/` with `a27-local-connector.e2e.ts`, `a28-ssh-connector.e2e.ts`, `a29-failing-stages.e2e.ts`, `a30-host-key-change.e2e.ts`, `a31-reconnect.e2e.ts` and a helper that builds and spawns the connector with a temporary `PARALLAX_CONNECTOR_HOME` and `--allow-net 127.0.0.0/8`; `.github/workflows/connector-e2e.yml` (path-filtered on pull requests as design §15 lists, `workflow_dispatch`, 15 minutes; and a weekly schedule running `go test ./...` on `macos-latest` and `windows-latest` and the full Playwright matrix); the extension of ADR-0006's table is already covered by its `connector-e2e` row.
- Tests: the five flows above: `A27 a student pairs a local connector and runs a cell` (including the loopback-only listener assertion), `A28 SSH and a jump host: host, account, workspace and kernel are visible and no Jupyter port is published`, `A29 forwarding forbidden, Jupyter missing and token rejected each name their stage and never reach Ready`, `A30 a rotated host key stops the connection and keeps the trust record`, `A31 offline then online runs the cell once`; plus the Go `fixture` tests with the same IDs.
- Spec: §10, §17. ADR-0005, ADR-0006; design §15. Scenarios: A27, A28, A29, A30, A31 (e2e). Depends on: P3-05a, P3-08. Model: sonnet. Security: yes. Size: M.
- Touches: `infra/compose.yml`, `infra/docker/sshd-jupyter.Dockerfile`, `infra/docker/jump.Dockerfile`, `infra/connector-fixtures/**`, `scripts/connector-fixture-keys.sh`, `connector/internal/fixture/**`, `e2e/tests/connector/**`, `.github/workflows/connector-e2e.yml`.

### P3-12 · Runner detailed design
- Scope: `docs/design/runner.md`: job and result JSON schemas, harness API for Python and R, check kinds and comparison modes, image contents and pinning, limit bounds, per-student cap, replay/regrade semantics, production placement and network policy; **rewrites P3-13, P3-14, P3-16, P4-11 in this plan**.
- Spec: §11. ADR-0004. Scenarios: none. Depends on: P1-07. Model: fable. Security: yes. Size: S.

### P3-13 · Runner worker
- Scope: `apps/runner` (`@parallax/runner`; dockerode 5.0.1, pg-boss 12.35.0, pg, zod, pino, workspace `@parallax/contracts`) per `docs/design/runner.md` §7: `src/config.ts` (`RUNNER_DATABASE_URL`, `RUNNER_SLOTS`, `RUNNER_IMAGES`, `RUNNER_PULL`, `RUNNER_DOCKER_RUNTIME`, `DOCKER_HOST`, `LOG_LEVEL`; nothing else), `src/policy.ts` (`buildContainerConfig`, `buildHostConfig(limits, dockerRuntime)`, pure, byte arithmetic without shifts, `Init: false` because the harness is pid 1, design §4.4 and §7.3), `src/payload.ts` (stdin stream: 33-byte nonce line + validated job JSON of at most 4 MiB; the harness's stdin cap is 4 MiB + 33 bytes, design §4.2), `src/frame.ts` (nonce-framed result parser; bytes outside the frame are noise), `src/classify.ts` (design §7.4; stdout read cap `outputBytes + 50 × 5 KiB + 64 KiB`), `src/images.ts` (allowlist resolved to ids and digests, design §6.4), `src/executor.ts` (dockerode: create, attach, start, write stdin and close it, kill timer `wall + 5 s`, wait, inspect, remove; nothing copied or mounted; start-up sweep of `parallax.runner=1` containers), `src/worker.ts` (pg-boss on schema `pgboss_exec` with `migrate: false, supervise: false`, one `work()` per slot with `perJobResults`, outcome sent as `execution.result` with `id: jobId` (a `null` send is the dropped duplicate, not an error) then returned as output, transient errors thrown, terminal ones dead-lettered), `src/main.ts`; `packages/contracts/src/runner.ts` (`RunnerJob`, `RunnerResult`, `RunnerOutcome`, `RUNNER_BOUNDS`, `clampLimits`, `validateJob` for the semantic rules of design §3.1) with `runner.test.ts` over `runner/protocol/v1/examples` (valid, `invalid/`, `rejected/`); `scripts/runner-role.sql` (design §10.3, `:app_role` variable); one-line amendment to ADR-0006's test table for the `runner` project; `infra/docker/runner.Dockerfile`; vitest project `runner` (`apps/runner/test/**/*.docker.itest.ts`, root script `test:runner`), unit include `apps/runner/src/**/*.test.ts`, integration include `apps/runner/test/**/*.itest.ts` with `exclude: ['**/*.docker.itest.ts']` so the Docker suites run only in the `runner` project (the `integration` CI job has Docker but not the image); CI job `runner` (from P3-14) extended with `pnpm test:runner` against the built image, and `integration` runs the new itests.
- Tests: `policy.test.ts` (both bounds of every limit, `Init: false`), `payload.test.ts` (a maximal 4 MiB job is written whole after the nonce line), `frame.test.ts` (a maximal frame at the minimum `outputBytes` with 50 checks fits the cap), `classify.test.ts` (valid frame over `OOMKilled`, exit 64 → `job_invalid`, the maximal frame at the minimum `outputBytes` is classified from its result), `images.test.ts`, `config.test.ts`, `log.test.ts`; `apps/runner/test/worker.itest.ts` (fake executor; result message, retry, dead letter through pg-boss read with `includeMetadata: true`); `apps/runner/test/a13-runner-role.itest.ts` (applies `scripts/runner-role.sql` in its own `beforeAll`, grants itself membership, `SET ROLE`; asserts `users` and `resource_revisions` denied, `pgboss.job` read and insert denied, `pgboss_exec.version` readable; P3-16 extends it with `execution_results`); `apps/runner/test/a13-sandbox.docker.itest.ts` with the probes named in design §11 and §12, `A13 writing to the container's stdout through pid 1 is refused and the result is still read` and `A13 signals from student code to pid 1 are discarded` included, and `A13 killed harness ends run unavailable, not passed` killing from the host with `docker kill -s KILL`.
- Spec: §11. ADR-0004; design §3, §7, §10, §11. Scenarios: A13. Depends on: P3-14. Model: opus. Security: yes. Size: M.
- Touches: `apps/runner/**`, `packages/contracts/src/runner.ts`, `vitest.config.ts`, `package.json`, `.github/workflows/ci.yml` (`runner` job), `infra/docker/runner.Dockerfile`, `scripts/runner-role.sql`, `docs/adr/0006-testing-strategy.md` (one line).

### P3-14 · Harness and Python runner image
- Scope: `runner/harness/run.py` (stdlib-only Python 3; `main(argv)` with `--work`, `--tmp` and repeatable `--ipc` defaulting to `/work`, `/tmp`, `/dev/shm` and `/dev/mqueue`, the tests spawning it as a subprocess with temporary roots and never calling the process-level parts in-process, and `run(job, work_dir, tmp_dir, clock, ipc_dirs)` behind it; nonce and job read from stdin (cap 4 MiB + the 33-byte nonce line) and held in memory, semantic rules of design §3.1 (exit 64), `PR_SET_DUMPABLE` and `PR_SET_CHILD_SUBREAPER`, the harness as pid 1 (`Init: false`; a no-op `SIGINT` handler installed at start-up and no `preexec_fn`, the rlimits being the container's `Ulimits`; the main thread waits with `waitpid(-1)` and reaps orphans as they die, the direct child's status taken from that call and written to `proc.returncode`; pipes, reader threads and the timer created before every spawn, no thread after it, the timer receiving the pid after the spawn and killing at once when its deadline has passed; a check ends with the timer cancelled, kill-and-reap, readers and timer joined, then the sweep; a spawn failure cancels the timer, closes the write ends and joins the readers and the timer before recording `error`/`spawn`; outside pid 1 the kill walks the harness's descendants through `/proc` instead of `kill(-1)`, design §4.2 and §4.3), compile phase over non-hidden files, per-check materialisation of the files that check may see plus a private `TMPDIR`/`HOME`, kill-and-reap and a sweep of everything under `/work`, `/tmp`, `/dev/shm` and `/dev/mqueue` after every check and after the compile phase, command table for python and r (`python3 -s -P -B`, never `-I`, so `PYTHONHASHSEED=0` takes effect), environment scrub, incremental capture against the job's `outputBytes` counted by encoded size, per-check `timeoutSeconds` that ends only that check (later checks run while wall budget remains), budget and process-group kill, cgroup `oom_kill` detection, comparison in the harness only with `expected`/`actual`/`message` cut by encoded size (2048/2048/512 bytes), nonce-framed result on stdout with `ensure_ascii=False` and a newline before the start marker; design §4), `runner/harness/launch.py` (puts the check directory first on `sys.path` and runs the program, because the interpreter runs with `-P`), `runner/harness/driver.py` (call driver; `driver.R` arrives with P4-11), `runner/harness/test_run.py` (`unittest`), `runner/images/python/Dockerfile` (base pinned by digest, `requirements.txt` with hashes for numpy, pandas, scipy, user 10001, harness at `/opt/parallax/harness`, labels; design §6), `scripts/runner-image.sh` (`hash`, `build` → `parallax-runner-<lang>:<content-hash>` and `:dev`), CI: one step in `check` running `python3 -m unittest discover -s runner/harness`, and a new job `runner` that builds the image and runs the harness tests inside it (`--network none`, uid 10001, no setuid binaries, labels).
- Tests: the P3-14 list in design §12 (stdin parsing including a maximal 4 MiB job and the rejected fixtures, compile error, every compare mode, call value/raises/exception, script, per-check timeout followed by a check that still runs, wall budget spent and skipped, output cut at `outputBytes`, environment keys and `two runs of a program printing a set of strings give identical output`, encoded-size cuts of `expected`/`actual`/`message`, hidden-file visibility per check, sibling import from the check directory, `nothing under a swept root survives a check` with a stash probe, `orphaned processes are reaped during a check` (including behind a daemon that holds the pipes, the readers being joined only after the kill-and-reap, and the end-of-check walk ending when only zombie descendants remain), `the direct child's returncode is set from the wait loop` (asserting `proc.returncode is not None` and the thread count with the timer thread joined, design §4.3), `student code sending SIGINT to the harness does not interrupt it`, `a student program receives SIGINT at its default disposition`, `reader threads and the timer exist before the child is spawned` (its pids-limit half only inside the image), `the timer receives the pid after the spawn and kills at once when its deadline has passed`, `a spawn failure tears down the pipes, readers and timer`, driver stdin without expected values, framing with the newline before the marker, missing nonce, result shape).
- Spec: §11. ADR-0004; design §4, §6. Scenarios: none (A13 is asserted through the executor in P3-13). Depends on: P3-12. Model: sonnet. Security: yes. Size: M.
- Touches: `runner/harness/**`, `runner/images/python/**`, `scripts/runner-image.sh`, `.github/workflows/ci.yml` (job `runner`, one step in `check`).

### P3-15 · Assignments and test attempts
- Scope: tables `assignments` (class × release resource × settings: attempts, timing, late policy, release policy, reported-grade rule), `assignment_overrides` (extension/extra attempt with reason), `test_attempts` (state machine per §11: Available → InProgress → Submitted → …; pinned question revision and grader version; eligibility and deadline computed server-side), `attempt_answers` autosave with acknowledgement, `submissions` with idempotency key and receipt, deadline job auto-submitting the latest acknowledged draft with `auto_submitted` and preserved unsent-local marker, retakes.
- As built: content schema `test.v1` (`packages/contracts/src/test.ts`: choice, numeric, explanation and `codeTask.v1` code questions with rubrics, author default settings; publication validation stays with P3-18); tables `assignments` (keyed by class and draft resource, so the class's terms survive a new release), `assignment_overrides` (append-only, latest grant in force), `test_attempts` (pinned `resource_revision_id`, `grader_version` hashing the grading material, the class's settings snapshotted at start, `deadline_at`, kept `local_copy`), `attempt_answers` (one row per question, client `seq` so an older save never wins; a trigger refuses writes once the attempt is closed) and `test_submissions` (immutable; `auto_submitted` exactly when it has no key); routes in `contracts/routes/tests.ts`; scoped job `tests.expire-attempt` sent at start and on an extension, and every read settles an attempt past its deadline. The submission service is `db/tests.ts` `submitAttempt`/`freeze`, where P3-16 adds its grading hook.
- Spec: §11, §13. Scenarios: A14, A15, A16, A21 (submissions per class). Depends on: P2-10, P1-05, P3-02 (migration chain). Model: opus. Security: yes. Size: M.

### P3-16 · Execution records and Run sample tests
- Scope: migration `NNNN_p3-16_execution.sql` with tables `execution_jobs` and `execution_results` (columns per design §8.3, both class-scoped and registered in `db/scoped.ts`), `CREATE SCHEMA IF NOT EXISTS pgboss_exec` and the `parallax_runner` role statements of `scripts/runner-role.sql` with `:app_role` taken from `DATABASE_URL`; `db/jobs/boss.ts` gains a `schema` option and `main.ts` a second instance `bossExec` on `pgboss_exec` (api and worker) that creates queues `execution.run` (dead letter `execution.failed`), `execution.result`, `execution.failed` at start-up; `config.ts` `RUNNER_RUNTIMES` (design §6.3); `execution/job-builder.ts` (`buildRunnerJob` dropping hidden checks and files from `public` jobs, `codeHash`, `graderVersion`, pure), `execution/runs.ts` (reuse of an identical terminal result within the same attempt, per-student cap of two sample runs across classes under an advisory lock counting only the rows the staleness rule of `execution/status.ts` calls live (pg-boss job `created`/`retry`/`active` whatever their age, or no job yet within the 60 s send window), their jobs looked up in one `SELECT id, state FROM pgboss_exec.job WHERE name = 'execution.run' AND id = ANY(…)`, and writing nothing to them → 429 with queue message, supersede of a run of the same attempt and question whose job no slot has fetched (job `created`/`retry`, or none yet within the send window, from the cap's lookup; a run whose job is `active` is neither cancelled nor uncounted, design §2 step 3), the same rule for the cancellation of an attempt's queued sample runs on submission and expiry (design §8.4), files holding a lone surrogate refused with 400 by the runs contract (design §3.1), priorities, `boss_job_id` chosen by the server with `randomUUID()`, written in the insert and passed to `bossExec.send` as `id`, the row committed before the send, `job_sent_at` set after the send with `UPDATE … WHERE state = 'queued' RETURNING state` and the job cancelled when that touches no row, the route answering the returned state, cancel of sample runs only), `db/scoped.ts` `forOwnRows(user, table)` with its introspection test (the recorded ADR-0002 exception, design §8.4), `execution/results.ts` (`recordOutcome` and `recordFailure`, the only writers of a row's terminal state besides cancellation, moving non-terminal rows only; `recordFailure` writes `failure = { kind, message }`, maps only pg-boss's `job timed out` output to kind `expired` and any other kind-less output to `unknown`, and owns the NeedsReview move of design §8.7; used by the worker mode handlers for `execution.result` and for `execution.failed` read with `includeMetadata: true` as the dead-lettered job document plus `sourceOutput`, design §8.5, idempotent, unknown id retried, and by read-time settlement), `execution/status.ts` (read-time `queued`/`running`/`queuePosition` via `bossExec.getJobById` and one count query; the staleness table of design §8.5, keyed on the pg-boss job's state and `output`, with the 60 s send window as the only wall clock: liveness for the cap, settlement under the row's own scope on read, a `cancelled` job → row `cancelled`, a gone run job `enqueue_failed` through a conditional update while `job_sent_at` is null and otherwise settled from the row's `execution.result` message found by `getJobById('execution.result', row.id)` before `lost`), `execution/view.ts` (`toStudentView`); contracts `routes/runs.ts` per design §8.6 (`POST …/questions/:questionId/runs`, `GET …/runs/:runId`, `GET …/questions/:questionId/runs?latest=1` serving students only `reason = 'sample'` runs, `POST …/runs/:runId/cancel`, instructor `POST …/questions/:questionId/replays` and `GET …/results`); grading hook on submission (`reason: grading`, `set: full`, priority 5) and NeedsReview on a dead-lettered grading run (design §8.7); `execution.*` queues are never scoped jobs (`jobs/scoped.test.ts` asserts no `*.job.ts` defines one).
- Tests: `job-builder.test.ts`, `a12-execution-contracts.itest.ts`, `a18-run-unavailable.itest.ts`, `a13-run-cap.itest.ts` (a new run for the same question while the earlier job is `active` does not cancel it and counts it; a `queued` row whose pg-boss job is still `created` is counted however old it is; rows whose job is gone, `completed`, or absent past the send window are not counted; the cap writes nothing to rows of other classes and looks every job up in one statement), `results.itest.ts` (dead letters produced through pg-boss, never hand-built; every row of the §8.5 staleness table at read time, including an outcome recorded from a `completed` job while its result message is still queued, a `failed` grading job settled on read moving the attempt to NeedsReview, pg-boss's timeout output mapped to `expired` and any other kind-less output to `unknown`, both into `failure`, a `cancelled` job settled `cancelled`, a send whose row was cancelled meanwhile cancelling its job (a job already fetched runs out and its result is dropped by the terminal row, design §2 step 4), a row settled with a result before the post-send update answered with its terminal state, a read deciding `enqueue_failed` concurrently with the post-send update leaving exactly one winner and a read-path `enqueue_failed` landing after the send cancelling the job by id, a row whose run job is gone settled from its queued result message rather than `lost`, a row whose job never appeared and has no result message `enqueue_failed` while `job_sent_at` is null and `lost` once it is set, and a dead letter worked after a `lost` read replacing `failure` with its kind through its own conditional update, state and attempt untouched, design §2 step 4), `a12-execution-contracts.itest.ts` refusing files with a lone surrogate, and `a13-runner-role.itest.ts` extended with `execution_results` (design §12).
- Spec: §11. ADR-0002/0004; design §2, §5, §8, §9. Scenarios: A12, A18, A13 (API cap). Depends on: P3-13, P3-15, P3-06 (migration chain). Model: opus. Security: yes. Size: M.
- Touches: `db/schema/execution.ts`, `db/scoped.ts`, `config.ts`, `db/jobs/boss.ts`, `execution/*`, `contracts/routes/runs.ts`, `http/routes/runs.routes.ts`, `main.ts` (second pg-boss instance, result handlers in worker mode), the submission service of P3-15 (hook call), `apps/runner/test/a13-runner-role.itest.ts`.

### P3-16a · Lone surrogates in autosave; submission leaves fetched sample runs
- Scope: from P3-12e, which aligned design §2, §3.1 and §8.4 with P3-16 as built. (1) The autosave route (`PUT …/test-attempts/:attemptId/answers/:questionId`, `parseAnswer` in `assessments/terms.ts`) refuses with `400` an answer whose text holds a lone surrogate (a code answer's file `content`, an explanation), the rule the runs contract already applies (`packages/contracts/src/routes/runs.ts`); today Postgres's jsonb refuses it on insert and the route answers `500` (design §3.1). (2) A test for the cancellation of an attempt's sample runs on submission (design §8.4): a run whose job is `created` is cancelled with its job; one whose job is `active` stays `queued`, finishes and is recorded. No change to the runner, the job builder or `validateJob`.
- Tests: `assessments/terms.test.ts` (lone surrogate refused, a paired surrogate such as an emoji accepted), an autosave integration test answering `400`, and in `a18-run-unavailable.itest.ts` or `results.itest.ts` `submission cancels the sample runs no slot has fetched and leaves an active one to finish` (design §12).
- Spec: §11. ADR-0002/0004; design §3.1, §8.4. Scenarios: none. Depends on: P3-16. Model: sonnet. Security: no. Size: S.
- Touches: `assessments/terms.ts`, `assessments/terms.test.ts`, the autosave and execution integration tests.

### P3-17 · Test UI
- Scope: terms panel in the prompt column, question navigation with Answered/Unanswered/Flagged, answer types, CodeMirror editor (line numbers, indentation, screen-reader mode toggle, downloadable draft), Run sample tests with output states (compile error, runtime error, expected/actual, timeout, resource exhaustion) and stale label, Review submission list, Submit with idempotency key and receipt after acknowledgement, expiry handling (server state fetch on reconnect, received-answers receipt, local copy preserved), `pc-test` CSS ported.
- Spec: §11, §14. Scenarios: A12, A14, A15 (e2e), A20 (test part). Depends on: P3-15, P3-16. Model: sonnet. Security: no. Size: M.

### P3-17a · Answer acknowledgement says whether the save was stored
- Scope: from the review of P3-17. The autosave route (`PUT …/test-attempts/:attemptId/answers/:questionId`) ignores a save whose `seq` is not above the stored one and answers the stored counter, so a tab saving at the same counter as another tab could not tell the stored answer's acknowledgement from its own. Its response is `saveAck` (`answerAck` plus `applied: boolean`, true only when this request's value is the one stored; receipts and attempt views keep `answerAck`), and `useAnswers` treats an unapplied save as not saved: it adopts the server's counter and sends again, as it does for a higher counter.
- Tests: `a14-a16-test-attempts.itest.ts` (same-counter save answers `applied: false` and leaves the stored answer), `assessments.test.tsx` (`A14 a save the server does not apply because another tab saved at the same counter is not shown as Saved and is sent again`).
- Spec: §11. Scenarios: A14. Depends on: P3-17. Model: opus. Security: yes. Size: S.
- Touches: `packages/contracts/src/routes/tests.ts`, `apps/server/src/db/tests.ts`, `apps/web/src/assessments/useAnswers.ts`.

### P3-18 · Test authoring
- Scope: editor for questions (quiz, numeric, explanation, code with language/version, starter files, allowed packages, I/O contract, limits within server bounds, sample and hidden checks), rubric, attempts/timing/release settings, preview runs of sample and hidden checks in the instructor preview context, publication validation per design §8.1 (rejections including a file path that is a directory prefix of another; a warning, not a rejection, when a question's hidden checks are `script`-only, with the test `publication warns on script-only hidden checks`).
- As built: web `authoring/TestEditor.tsx` (questions, rubric, attempts, timing and release settings; autosave sends the questions only once `test.v1` parses, as the exercise editor does), `CodeQuestionEditor.tsx` (runtime picker from `GET /api/courses/:courseId/runtimes`, files, allowed packages, limits within `RUNNER_BOUNDS`, sample and hidden checks) and `PreviewRunPanel.tsx`; `execution/publication.ts` `testPublicationIssues`, called by `validate` in `db/content/releases.ts` (codes `invalid_test`, `script_only_hidden_checks`; the routes pass `RUNNER_RUNTIMES`, which every caller must supply). Beyond design §8.1 it rejects a rubric worth more than its question and impossible settings (`settingsProblems`). Rules a runner job states (unique check names, files a check names, directory prefixes, sizes) come from `validateJob` through the job built for both check sets; `publication.ts` adds only what a job cannot express. Design §8.1's last sentence (running the author's hidden checks in the preview context so a broken hidden test is found first) is met by the editor's manual preview run plus that static build of the full job, not by a run at publication (spec §12: preview *can* run hidden tests). Preview runs: `POST /api/courses/:courseId/resources/:resourceId/questions/:questionId/preview-runs` and `GET …/preview-runs/:runId` (course `editor` scope) run the draft's head revision in the oldest live class of the course the caller teaches, as that class's preview principal (`previewRunClass`, `db/preview.ts`; `context = 'preview'`, no attempt, no cap), through `requestPreviewRun`/`readPreviewRun` in `db/execution/runs.ts`; `409 no_class` when the caller teaches none. A run is read back through any of the caller's preview principals in classes of the course they teach (`previewPrincipals`, no lock), so it stays readable when that class is archived. The publish and validate routes now check test content, so fixtures that publish a test need `test.v1` content.
- Spec: §11, §12. Scenarios: none. Depends on: P3-15, P3-16, P1-14. Model: sonnet. Security: yes. Size: M.

## 5. Phase 4 — grading, exports, recovery, accessibility, operations

### P4-01 · Grading schema and API
- Scope: tables `grades` (attempt, rubric revision, automated and manual components, state draft|released, history), `grade_overrides` (reason, prior result retained), `grade_releases` (actor, time, recipients); draft save, release single/bulk with preview of exact recipients, reported grade per assignment rule, regrade creating a new result, feedback attached to question/code line/attempt, audit.
- As built: migration `0011_p4-01_grading.sql`; `grades` is append-only per attempt (`number` 1, 2, …; `source` draft | regrade | override; a trigger allows one change, draft → released with `release_id`/`released_at`), each row holding per-question `questions` (automated part with the execution `resultId`, manual rubric part) and `feedback` (attempt, question or code line); `grade_overrides` (points, reason, `prior_grade_id` kept unchanged) and `grade_releases` (actor, time, recipients) are append-only; `test_attempts.report_selected` for the `instructor_selected` rule. Scoring rules are pure in `assessments/grading.ts` (a question's rubric is its manual share, the rest is automated; a code question's automated share × passed check points / all check points of its latest full-run result; a missing part leaves the grade incomplete and unreleasable until an override; an attempt already Graded stays Graded when a later regrade is incomplete, since §11 has no Graded → NeedsReview move, and release skips it as `incomplete`). Service `db/grades.ts`, contracts `contracts/routes/grades.ts`: instructor `GET|POST …/test-attempts/:attemptId/grade` (history, automated components; draft save with `expectedGradeId`), `POST …/grade/regrade` and `…/grade/override` (reason required), `POST …/grade-releases/preview` and `POST …/grade-releases` (exact `{attemptId, gradeId}` pairs, else 409 with a fresh preview), `GET …/resources/:resourceId/grades` (reported grade from released grades), `PUT …/grades/selection`; student `GET …/resources/:resourceId/results` (own attempts: in_progress | pending | released, released rows only).
- Spec: §11, §12. Scenarios: A17, A18. Depends on: P3-16 (migration chain). Model: opus. Security: yes. Size: M.

### P4-02 · Class review table
- Scope: `GET /api/classes/:classId/review` (name, exercise status, test status/score, open questions, last submission; preview users excluded), filters topic/assignment/student/Needs review, pagination, selected assignment and attempt kept visible, previous/next student over the filtered list, empty state with Show all students.
- Spec: §12. Scenarios: A25. Depends on: P4-01. Model: sonnet. Security: no. Size: M.

### P4-03 · Grading workspace and student views
- Scope: split workspace (submitted answer/code and execution result | rubric, score, feedback), Results/Submissions/Comments & questions tabs, notebook snapshot inspection, Save draft grade, Release feedback, bulk release preview, override with reason, links to source passages; cohort name visible.
- Spec: §12. Scenarios: A17, A25, A35 (e2e). Depends on: P4-02, P3-09. Model: sonnet. Security: no. Size: M.

### P4-04 · Student results view
- Scope: released results with points, rubric feedback, per-line code feedback, release-policy-limited details; distinct states for zero score, unsubmitted, grading failure, pending; "find released feedback" journey.
- Spec: §11. Scenarios: A20 (feedback part). Depends on: P4-01, P3-17. Model: sonnet. Security: no. Size: S.

### P4-05 · CSV export
- Scope: class-scoped CSV (course, class, assignment, attempt, grade state, numerator/denominator, timestamps), formula-injection neutralisation for user text, audit event, download via content token.
- Spec: §12. Scenarios: A21 (export scoped). Depends on: P4-01. Model: sonnet. Security: yes. Size: S.

### P4-06 · Recovery and failure states
- Scope: instructor recovery request for preserved unsent local work (student uploads local copy from IndexedDB with attempt binding), save-failure retry and recovery download for long answers/code, conversion/renderer failure states with retry and source download, execution service failure state.
- Spec: §11, §14. Scenarios: A15 (recovery path), A18 (UI). Depends on: P3-17, P2-06. Model: sonnet. Security: no. Size: M.

### P4-07 · Backup and restore verification
- Scope: `scripts/backup.sh` (pg_dump + storage snapshot manifest) and `scripts/restore.sh`, integration test that backs up the fixture world with a graded attempt, restores into a fresh database and storage root, and verifies attempt, resource revision, code, grader version and released feedback; weekly CI job.
- Spec: §13. Scenarios: A22. Depends on: P4-01. Model: opus. Security: no. Size: M.

### P4-08 · Accessibility validation
- Scope: axe on every route in e2e, keyboard-only journeys (courses → reading annotation → exercise → code test → feedback), screen-reader labels and status announcements audit, 320 px width and 200 % zoom checks with horizontal scroll confined to code/tables/tab strip, focus restoration for sheets, fixes found.
- Spec: §14. Scenarios: A19, A20. Depends on: P4-04, P4-03. Model: sonnet. Security: no. Size: M.

### P4-09 · Data export, deletion, archive and retention
- Scope: student annotation/data export (text, resource titles, references, drawings as SVG), authorised deletion (and account deactivation) that calls `revokeUserConnectors(userId)` and anonymises identity while retaining organisation-required records, archive/restore for classes and courses with read access retained, retention job skeleton with explicit policy config, audit.
- Spec: §8, §12, §13. Scenarios: none. Depends on: P4-01 (migration chain). Model: sonnet. Security: yes. Size: M.

### P4-10 · Load test and queue visibility
- Scope: script starting a test for 200 seeded students within a minute against compose, execution queue position visible in the Test UI, weekly CI job reporting p95 timings against §14 budgets.
- Spec: §14. Scenarios: none. Depends on: P3-17. Model: sonnet. Security: no. Size: S.

### P4-11 · R runner image
- Scope: `runner/images/r/Dockerfile` from `rocker/r-ver:4.6.1` pinned by digest, plus `python3` from the Ubuntu base for the harness and `jsonlite` from the image's frozen CRAN snapshot, user 10001, labels (design §6); `runner/harness/driver.R` (design §4.5) and the R branch of `run.py` where P3-14 left it as a command table; harness tests for R (skipped where `Rscript` is absent, run inside the image in the `runner` CI job, which also builds this image); `apps/runner/test/a13-sandbox-r.docker.itest.ts`; runtime `r-4.6` in `RUNNER_RUNTIMES` and `RUNNER_IMAGES` defaults; the test editor's runtime picker (P3-18) lists it and publication validation checks `allowedPackages` against its package list.
- Spec: §11. Design §4, §6. Scenarios: A13 (R variant). Depends on: P3-13, P3-18. Model: sonnet. Security: yes. Size: M.
- Touches: `runner/images/r/**`, `runner/harness/driver.R`, `runner/harness/run.py`, `runner/harness/test_run.py`, `apps/runner/test/a13-sandbox-r.docker.itest.ts`, `.github/workflows/ci.yml` (`runner` job), `apps/server/src/config.ts`.

### P4-12 · Operational readiness
- Scope: structured logs that never include private content or tokens (tested), rate limits on auth and execution endpoints, readiness endpoint with dependency detail, prod-like `infra/compose.prod.yml` (api, worker, relay, runner, optionally the managed connector of P3-05b on separate networks, Postgres, Garage), config surface for session/lease/limit defaults, runbook `docs/operations.md`.
- Spec: §13, §14, §17. Scenarios: none. Depends on: P4-05. Model: sonnet. Security: yes. Size: M.

### P4-13 · Extensions and accommodations UI
- Scope: instructor grants extension or extra attempt with reason (API from P3-15), student sees effective settings and time zone, audit display.
- Spec: §11. Scenarios: none. Depends on: P4-02, P3-17. Model: sonnet. Security: no. Size: S.

## 6. Scenario coverage

| Scenario | Items (owner first) | | Scenario | Items (owner first) |
| --- | --- | --- | --- | --- |
| A01 | P1-01, P1-02, P1-03, P1-06, P1-09, P1-16 | | A19 | P4-08, P1-09 |
| A02 | P1-01, P1-03, P1-09, P1-10, P1-11 | | A20 | P4-08, P3-17, P4-04 |
| A03 | P1-12, P2-06, P1-11 | | A21 | P1-01, P1-06, P2-04, P3-15, P4-05 |
| A04 | P2-02, P1-13 | | A22 | P4-07 |
| A05 | P2-04, P2-06, P2-07 | | A23 | P2-10, P2-11 |
| A06 | P2-05, P1-08 | | A24 | P2-02, P2-09 |
| A07 | P2-08 | | A25 | P4-02, P4-03 |
| A08 | P2-10, P2-11 | | A26 | P1-15, P1-04, P1-04a, P1-05, P1-14 |
| A09 | P2-13, P3-08 | | A27 | P3-04, P3-03, P3-07, P3-08, P3-11 |
| A10 | P2-14 | | A28 | P3-05, P3-05a, P3-11 |
| A11 | P2-15 | | A29 | P3-05, P3-05a, P3-07, P3-11 |
| A12 | P3-16, P3-17 | | A30 | P3-05, P3-06, P3-07, P3-11 |
| A13 | P3-13, P3-16, P4-11 | | A31 | P3-06a, P3-08, P3-11 |
| A14 | P3-15, P3-17 | | A32 | P3-04a, P3-06, P3-08 |
| A15 | P3-15, P3-17, P4-06 | | A33 | P3-06, P3-02, P3-04, P3-10 |
| A16 | P3-15, P1-04, P1-05, P1-14 | | A34 | P3-09, P3-09a |
| A17 | P4-01, P4-03 | | A35 | P3-09, P3-09a, P4-03 |
| A18 | P3-16, P4-01, P4-06 | | A36 | P3-04a, P3-05a, P3-06, P3-07, P3-08 |

Every scenario A01–A36 is owned by at least one item. Each item's PR adds a file `docs/delivery/done/<ID>.txt` listing, one per line, the scenario IDs whose tests it adds (an empty file if none). A new file per item means parallel PRs never conflict here. `pnpm scenarios` fails if an ID listed in any of those files has no test, so scenario tests cannot silently disappear.

## 7. Deferred until a human provides accounts, secrets or decisions

None of these blocks Phases 1–4, which run entirely locally and in GitHub Actions.

- Hosting provider, region, domain names for the app and content origins, TLS certificates, and the production compose/orchestration target.
- Production identity provider (institutional OIDC/SAML); the `IdentityProvider` interface and email links stand in.
- Outbound email provider credentials (`MAIL_TRANSPORT=smtp` settings); the file transport is used until then.
- Production object storage bucket and credentials (`STORAGE_DRIVER=s3`); the `fs` adapter and Garage cover dev/CI.
- Dedicated runner host with gVisor, and the network policy between runner, API and Postgres.
- Connector code signing (Windows Authenticode, macOS notarisation), update channel and revocation procedures; Phase 3 ships unsigned GitHub release artifacts.
- Actual Colab and Shiny hosts, approved embed origins, and any Shiny result adapter.
- Institution SSH/VPN rules, HPC scheduler adapters, and the supported OS/runtime matrix sign-off.
- Backup destination, retention policy, and legal sign-off for deletion behaviour.
- Monitoring/alerting stack and log retention.
- Repository settings: branch protection, required checks, Dependabot for `github-actions`, npm, Go and Docker.

## 8. Open questions and defaults chosen

| # | Gap or ambiguity | Default used by this plan |
| --- | --- | --- |
| 1 | §17 asks whether instructors may see personal annotations beyond shared work | Private by default; only threads with audience instructor/class are visible to instructors (P2-04) |
| 2 | What a student sees after choosing the instructor entrance | `/courses?view=teach` shows an access explanation and their enrolled classes; no privilege change (P1-09) |
| 3 | How "Preview as student" identity is realised | Shadow user (`kind = preview`) per instructor × class with an `is_preview` student membership (ADR-0002) |
| 4 | Slide rendering: server rasterisation vs client rendering | Client-side pdf.js with HTTP range requests; server extracts page count and text only (P2-01). Raster-only decks require a text alternative at publication; a deck is raster-only when fewer than half of its pages carry text (`derived.rasterOnly`, P2-01) |
| 5 | Format of "instructor-authored web slides" | Markdown deck separated by `---`, rendered through the reading pipeline (P2-03) |
| 6 | Exercise definition format | Versioned JSON (`exercise.v1`) validated by zod, edited through a form; no DSL (P2-10) |
| 7 | Hidden-check storage | Inside the test resource revision; student contracts use response schemas without those fields, asserted structurally (P3-16) |
| 8 | Runner isolation in production vs CI | Same Docker policy everywhere; gVisor runtime enabled by config on the dedicated production host (ADR-0004) |
| 9 | Server-side (managed) connector requirement | Same Go binary in `--managed` mode, optional deployment; not needed for A27–A36 (ADR-0005) |
| 10 | Lease defaults (§10.4 "visible and enforced") | 30 min idle, 5 min grace, shown before Connect; class-level override later |
| 11 | Time zone display | Browser time zone, labelled explicitly; server stores UTC and decides lateness (P3-15) |
| 12 | Timed-attempt expiry while the student is offline | pg-boss job at the deadline submits the latest acknowledged draft as `auto_submitted`; local unsent work stays in IndexedDB for the recovery request (P3-15, P4-06) |
| 13 | Idempotent submission key | Client-generated UUID per Submit action, unique per attempt (P3-15) |
| 14 | Object storage in dev/CI | `fs` adapter default; MinIO unavailable on Docker Hub, Garage used for the S3 adapter test (ADR-0001) |
| 15 | Topic completion rule shape | JSON `{ requires: ['reviewed:*', 'submitted:<resourceId>'] }`; default (no rule) = `['reviewed:*', 'submitted:*']`: every ungraded resource reviewed and every graded resource (a `test`, or an exercise assigned for credit) submitted. As built in P2-16 a submission is a notebook submission or a completed exercise attempt; a test submission arrives with P3-15, so until then a topic with a test needs an author rule that omits it to complete. A topic is never complete while a prerequisite is incomplete. |
| 16 | Cross-class visibility of discussions in one course | Never; discussions are class-scoped rows (A21) |
| 17 | Naming collision "session" | `auth_sessions` vs `notebook_sessions` |
| 18 | TypeScript 7 (native) is the npm `latest` | Use 5.9.3 for tooling and agent familiarity; revisit in 2027 |
| 19 | Go 1.24.7 in sessions vs current `x/crypto` needing 1.26 | `go 1.24` with `x/crypto v0.48.0`; P3-01 decided: stay on `go 1.24` with `x/crypto v0.48.0` until the session image ships Go ≥ 1.26 (`docs/design/connector.md` §13) |
| 20 | Playwright version | 1.56.1 to match `/opt/pw-browsers` Chromium 1194; CI installs the same version |
| 21 | Docker daemon absent in cloud sessions | Docker suites skip locally (`describe.skipIf`), mandatory in CI; `scripts/pg-local.sh` provides Postgres without Docker (validated as root via `runuser -u postgres`) |
| 22 | GitHub Actions versions | Major tags (`checkout@v5`, `setup-node@v5`, `setup-go@v6`, `pnpm/action-setup@v4`, `cache@v4`, `upload-artifact@v4`, `setup-buildx-action@v3`, `build-push-action@v6`); api.github.com was blocked from the sandbox; Dependabot for `github-actions` is deferred to the owner (§7) |
| 23 | Data deletion semantics (§13 "authorised deletion while retaining records") | Anonymise identity and delete private annotations/drafts; retain grades, submissions and audit rows under a pseudonym until a retention policy says otherwise (P4-09) |
| 24 | Per-student concurrent run cap when a class of 200 starts together | Cap 2 per student on sample runs only; grading runs are system work at lower priority; queue position shown; runner slots configurable (`docs/design/runner.md` §5; P3-16, P4-10) |
| 25 | Wireframe padding at ≤ 800 px (24 px) vs spec "16 px at phone widths" | 24 px at 541–800 px, 16 px at ≤ 540 px, as DESIGN.md states; spec §5's "phone" is the ≤ 540 px band |
| 26 | How a job enters and a result leaves a container with a read-only root and tmpfs `/work` (ADR-0004 used `putArchive` and `/work/result.json`; Docker refuses copies into a read-only root and tmpfs does not survive exit) | The job follows the nonce on the attached stdin and lives only in the harness's memory; the harness prints one nonce-framed result document to stdout (`docs/design/runner.md` §4.2, §4.4, §13) |
| 27 | How runner results reach the server, and how far a compromised runner role reaches | A second pg-boss schema `pgboss_exec` holds `execution.run`, `execution.result` and the dead-letter queue `execution.failed`; the runner role is granted there only, so it cannot read or enqueue the actor-bearing scoped jobs in `pgboss`; the server worker consumes results and dead letters, and `queued`/`running` are read-time lookups (`docs/design/runner.md` §8.4, §8.5, §10.3) |
| 28 | One harness per language vs one harness | One stdlib-Python harness in both images with a small `driver.py`/`driver.R`; the R image installs `python3` for it (`docs/design/runner.md` §4.1) |
| 29 | How the first owner of a deployment gets a first course (spec §3: instructor access comes from an invitation; `POST /api/courses` from P1-10 requires an account that already teaches) | Not decided: operator provisioning (seed or allow-list) is a deployment decision under spec §17. P1-14 adds no course-creation path; owner to decide before the pilot |
| 30 | Supported connector and SSH-target OS matrix (spec §17) | Connector: Linux, macOS and native Windows, amd64 and arm64 where listed; WSL by running the Linux connector inside the distribution. SSH targets: Linux and macOS start and attach; Windows OpenSSH hosts unsupported in v1. Jupyter Server 2.x, ipykernel 6 or 7, Python 3.9–3.13 (`docs/design/connector.md` §13) |
| 31 | Credential and MFA methods (spec §17) | SSH agent, then key file with optional certificate, then `keyboard-interactive` as a second factor typed in the connector's own terminal; no password, GSSAPI, `ProxyCommand` or OS keychain in v1; nothing secret ever crosses Parallax (`docs/design/connector.md` §5.3) |
| 32 | Number of relay processes | One `relay` process in production and the pilot; the live-link registry is in memory (`docs/design/connector.md` §10.1) |
| 33 | Connector URLs | `/api/connector/v1/…` so the structural scope guard applies (`docs/design/connector.md` §17) |
| 34 | Who operates managed connectors (spec §17) | Not decided; the mode is specified and scheduled as P3-05b, registered by an operator script because no instance-administrator role exists (item 29) |

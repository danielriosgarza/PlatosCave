# ADR 0001 — Technology stack

**Status:** Accepted, 2026-09-30

## Context

The specification (§13) leaves provider and framework open but fixes the constraints: relational records, private versioned object storage, an execution/conversion queue, isolated code workers, a notebook connection service, and a distributable compute connector (§10). Hosting and identity provider are undecided, so everything must run locally and in GitHub Actions, and production must stay portable (containers). Work is delivered by AI coding sessions one item per PR, reviewed by another model and merged on green CI, so the stack must be boring, strongly typed, well documented, and fast to test (PR CI under ~10 minutes).

Session environment (checked 2026-09-30): Node 22.22.2, pnpm 10.33.0 (corepack 0.34), Python 3.11.15 with pip, Go 1.24.7, Docker CLI 29.3.1 + Compose v5.1.1 **but no reachable daemon in cloud sessions**, PostgreSQL 16.13 client *and* server binaries (`initdb`, `pg_ctl`), Playwright 1.56.1 with Chromium build 1194 pre-installed at `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`. All versions below were read from npm, PyPI, the Go proxy and Docker Hub on 2026-09-30, not from memory.

## Decision

**One application language.** TypeScript 5.9.3 for the web app, API, job workers, notebook relay, runner orchestrator, scripts and e2e tests. Go 1.24 only for the compute connector binary (single static executable, mature SSH library). Python/R appear only inside runner and CI fixture images; the only Python we author is the in-sandbox test harness. TypeScript 7.0.2 (native compiler) is current but tooling and agent familiarity favour 5.9; revisit in 2027.

| Concern | Choice (exact version) |
| --- | --- |
| Runtime, package manager | Node 22 (`node:22.23.3-bookworm-slim`), pnpm 10.33.0 via corepack (`packageManager` field), pnpm workspaces |
| HTTP API | Fastify 5.12.5; zod 4.6.5 + fastify-type-provider-zod 7.0.0 for validation; @fastify/swagger 9.9.0 (OpenAPI for the Go connector and docs); @fastify/cookie 11.1.2, @fastify/static 10.1.5, @fastify/multipart 10.1.2, @fastify/websocket 11.3.1, @fastify/helmet 13.1.1, @fastify/rate-limit 11.2.0, @fastify/sensible 6.0.6; pino 10.3.1 (pino-pretty 13.1.3 dev) |
| API contract | Hand-rolled `defineRoute` contracts in `packages/contracts` (zod schemas + mandatory `scope`, see ADR-0002); the web client calls contracts directly (no codegen); OpenAPI is generated from the same schemas for Go |
| Database | PostgreSQL 16 (`postgres:16.15`); drizzle-orm 0.45.3 with `pg` 8.23.0; drizzle-kit 0.31.11 generates SQL migrations that are committed and applied by a runtime migrator (`drizzle-orm/node-postgres/migrator`), so production images need no drizzle-kit |
| Background jobs | pg-boss 12.35.0 (queue lives in Postgres, no Redis). Trusted jobs run in `apps/server` worker mode; sandboxed code runs in `apps/runner` with a DB role limited to the `pgboss` schema (ADR-0004) |
| Object storage | `Storage` interface with `fs` adapter (dev/CI/test default, directory under `.local/storage`) and `s3` adapter (@aws-sdk/client-s3 3.1143.0) tested in CI against Garage `dxflrs/garage:v2.4.1`. The app never hands out bucket URLs: it streams objects through signed, short-lived content tokens on an isolated content origin (ADR-0002). MinIO was rejected: its Docker Hub repository was empty on 2026-09-30 |
| Email sign-in links | Own implementation (token table, single-use, expiring) behind an `IdentityProvider` interface; nodemailer 10.0.13 with transports `file` (dev/test: one JSON file per message under `.local/mail`, read by Playwright), `smtp` (production; `axllent/mailpit:v1.31.3` optional for a local inbox UI) |
| Web app | React 19.3.0, Vite 8.3.1, @vitejs/plugin-react 6.1.1, TanStack Router 1.170.40 file-based routes (router-plugin 1.168.41, `routeTree.gen.ts` committed, generated), TanStack Query 5.104.0. Served by the API container in production (`@fastify/static`), Vite dev server with `/api` proxy in development |
| UI approach | No component framework, no Tailwind. Plain CSS + CSS Modules. `packages/ui/src/tokens.css` defines `--pc-*` custom properties copied from DESIGN.md frontmatter using `light-dark()`; a unit test parses DESIGN.md and fails if they drift. Component CSS is ported from `docs/wireframe.html` one component per module |
| Content rendering | unified 11.0.5, remark-parse 11.0.0, remark-math 6.0.0, remark-rehype 11.1.2, rehype-katex 7.0.1, rehype-highlight 7.0.2, rehype-sanitize 6.0.0, rehype-stringify 10.0.1, katex 0.18.9; pdfjs-dist 6.3.289 (readings, decks); dompurify 3.4.16 (client-side notebook output sanitising); CodeMirror 6 (`codemirror` 6.0.2, `@codemirror/lang-python` 6.2.1) |
| Tests | Vitest 5.0.2 (unit, component with jsdom 30.1.1 + @testing-library/react 16.3.3, integration against real Postgres); @playwright/test **1.56.1** (pinned to the container's Chromium 1194; CI installs the same version); @axe-core/playwright 4.13.0; `go test` |
| Lint / format / types | Biome 2.5.14 (lint + format for TS/JSON/CSS); `tsc` 5.9.3 `--noEmit` per package; `gofmt -l` + `go vet` for Go (staticcheck/golangci-lint current releases need Go 1.26) |
| Server execution | `tsx` 4.23.15 runs TypeScript directly in dev and in the production image (no bundling step; `tsc` only type-checks). Workspace packages export `src/index.ts` |
| Connector (Go) | `go 1.24` directive; golang.org/x/crypto v0.48.0 (newest whose go.mod allows 1.24; v0.49+ need 1.25, v0.56+ need 1.26), github.com/coder/websocket v1.8.15. Raising the `go` directive later triggers Go's automatic toolchain download, acceptable in CI and sessions with proxy.golang.org reachable |
| Runner / fixtures | dockerode 5.0.1; images built from `python:3.12-slim` (jupyter-server 2.21.1, ipykernel 7.4.0, nbformat 5.11.1) and `rocker/r-ver:4.6.1` |

**Monorepo layout** (pnpm workspace; names `@parallax/*`): `apps/server` (API + worker + relay), `apps/web` (SPA), `apps/runner` (Phase 3, sandbox orchestrator), `packages/contracts` (zod route contracts, shared types), `packages/ui` (tokens, shared CSS, primitives), `connector/` (Go module), `runner/` (images and harness), `e2e/` (Playwright), `infra/` (compose, Dockerfiles), `scripts/`, `docs/`. Exact tree in `docs/delivery/plan.md` Phase 0.

## Consequences

- Every session can run lint, typecheck, unit, component and (via `scripts/pg-local.sh`) integration and e2e tests **without Docker**; Docker-dependent suites (runner, connector fixtures) skip when no daemon is present and are mandatory in CI.
- Playwright upgrades require the session image's browsers to be updated first; `@playwright/test` stays at 1.56.1 until then.
- pg-boss keeps the service count at one (Postgres) for Phases 1–2; the queue table is a small operational cost at pilot scale.
- Two languages means two toolchains in CI (`go` job runs in parallel; ~2 minutes).
- `tsx` in production trades ~1 s cold start for zero build configuration; a bundling step can be added later without changing code.

## Alternatives considered

- **Next.js / Remix**: server-component and caching semantics are a frequent source of agent error, and the connector needs a language-neutral HTTP/WS contract, which a plain API provides directly.
- **tRPC / ts-rest**: excellent end-to-end types but Go must speak the same protocol; zod contracts + OpenAPI cover both without codegen churn.
- **Prisma**: engine binaries and a separate schema DSL; drizzle keeps schema in TypeScript and emits plain SQL.
- **Redis + BullMQ**: an extra stateful service for no Phase 1–4 benefit.
- **Tailwind / a component library**: would re-express DESIGN.md tokens twice; the wireframe's CSS is small and already correct.
- **Connector in TypeScript (Node SEA) or Python (PyInstaller)**: awkward single-binary distribution; Go cross-compiles static binaries and ships a mature SSH client.
- **Postgres row-level security** as the primary isolation mechanism: see ADR-0002 (kept as optional hardening).

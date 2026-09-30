# ADR 0006 — Testing strategy

**Status:** Accepted, 2026-09-30

## Context

Spec §16 lists 36 acceptance scenarios; §17 orders the build. PRs are written by one model, reviewed by another and merged by an orchestrator when CI is green, so the tests are the product's memory: every scenario must be an automated test with a stable name, and CI must finish in about ten minutes on every PR. Cloud sessions have Node, Postgres binaries and a pinned Chromium but no Docker daemon; CI has Docker.

## Decision

**Levels and locations.**

| Level | Tool | Location / pattern | Needs |
| --- | --- | --- | --- |
| Unit | Vitest project `unit` | `*.test.ts` beside the code in `packages/*`, `apps/server/src`, `scripts` | nothing |
| Component | Vitest project `component` (jsdom, Testing Library) | `apps/web/src/**/*.test.tsx` | nothing |
| Integration | Vitest project `integration` | `apps/server/test/integration/**/*.itest.ts` | `DATABASE_URL` (compose or `scripts/pg-local.sh`); `fs` storage in a temp dir; `file` mailer |
| Docker integration | same project, `*.docker.itest.ts` | runner and connector fixtures | Docker; `describe.skipIf(!dockerAvailable())`, mandatory in CI |
| End-to-end | Playwright 1.56.1, Chromium only | `e2e/tests/**/*.e2e.ts` | built web + server started by Playwright `webServer`, seeded e2e database |
| Accessibility | @axe-core/playwright inside e2e | `e2e/tests/a11y/*.e2e.ts` and `expectNoA11yViolations(page)` in feature tests | as e2e |
| Go | `go test ./...` | `connector/**/*_test.go` | in-process SSH/Jupyter fakes |
| Load | k6-free Node script, weekly only | `scripts/load/start-test.ts` | staging-like compose |

**Scenario naming.** A test that realises an acceptance scenario puts the ID first in its title: `test('A05 classmate cannot read a private note', …)`, `it('A14 double submit returns the same receipt')`, Go: `func TestA30_ChangedHostKeyBlocks(t *testing.T)`. Files for scenario suites are named `a05-annotation-audience.itest.ts`, `a27-local-connector.e2e.ts`. One scenario may be covered at several levels (API rule in an `itest`, user-visible behaviour in an `e2e`); the plan's coverage table names the item that owns each. `scripts/check-scenarios.ts` greps test titles for `\bA(0[1-9]|[12][0-9]|3[0-6])\b`, prints the coverage table, and fails if a scenario ID recorded as done has no test. Each merged item records its covered IDs in its own file `docs/delivery/done/<ID>.txt`, added by the item's PR (one file per item, so parallel PRs never conflict).

**Fixtures.** `apps/server/test/fixtures/world.ts` builds the standard world (ADR-0002) through the same service functions the API uses; `scripts/seed.ts` reuses it for the e2e database and local development. Time is injected (`Clock`), randomness seeded, ids deterministic in fixtures, so assertions can be exact.

**Integration database.** Global setup creates `parallax_template` from the migrations once per run; each `itest` file clones it (`CREATE DATABASE … TEMPLATE parallax_template`, ~50 ms) and drops it afterwards, so files run in parallel with no shared state. Tests never mock the database.

**E2E.** Playwright starts the server (`STATIC_DIR` pointing at the built web app, `MAIL_TRANSPORT=file`, `STORAGE_DRIVER=fs`, `CONTENT_HOST=127.0.0.1`, `APP_HOST=localhost`) and reuses it across tests. Sign-in helpers request a link and read the newest JSON message from `.local/mail`. Each test creates its own users through the fixture API (`/api/test/…` routes exist only when `TEST_ROUTES=1`, refused otherwise) or uses seeded personas. No `waitForTimeout`; assertions wait on visible state. `retries: 1` in CI only; a test that needs a retry is a bug to fix.

**CI on every PR** (`.github/workflows/ci.yml`, all jobs parallel, `timeout-minutes` set, `concurrency` cancels superseded runs):

| job | steps | budget |
| --- | --- | --- |
| `check` | pnpm install (store cache), `biome ci`, `tsc --noEmit` per package | 2 min |
| `unit` | `vitest run --project unit --project component` | 2 min |
| `integration` | Postgres 16.15 service (+ Garage via compose from P1-06), migrate, `vitest run --project integration` | 4 min |
| `e2e` | build web, `playwright install --with-deps chromium` (cached by version), `playwright test`, upload report on failure | 5 min |
| `go` | `gofmt -l`, `go vet`, `go build` (all targets), `go test` | 2 min |
| `image` | `docker build` server image (GHA layer cache), no push | 2 min |
| `runner` (from P3-13) | build runner image, `*.docker.itest.ts` for A13 | 4 min |
| `connector-e2e` (from P3-11) | compose `sshd-jupyter` + `jump`, connector build, Playwright A27–A31 | 5 min |

Wall time stays under ten minutes because jobs run in parallel; per-test budgets: unit file < 2 s, itest < 5 s, e2e test < 30 s. A weekly `schedule` runs the load script and the full Playwright matrix at 1440 × 900, 1024 and 320 px with 200 % zoom.

**Actions budget.** The repository is private, so GitHub Actions minutes are metered per job and rounded up. The table above is the target shape, but in practice `check`, `unit` and `go` run as one `check` job, `image` runs from a separate path-filtered workflow, CI triggers on `pull_request` and `workflow_dispatch` only, and scheduled workflows run weekly (see `docs/delivery/plan.md` §1.9). New jobs must justify their minutes.

**Definition of done for an item.** Tests for every scenario in its `Scenarios` field exist with the ID in the title; `pnpm check` (lint, typecheck, unit, component) passes locally; integration/e2e pass in CI; the PR body lists `Scenarios: A05 (itest, e2e)`.

## Consequences

- Real Postgres in integration tests means schema bugs surface in PR CI, at the cost of a service container.
- Pinning Playwright to the container's browser build avoids downloads in sessions; upgrading is a deliberate, image-first change.
- Docker-only suites are invisible to cloud sessions; authors must keep the Docker-touching code thin and unit-test the logic around it.
- The scenario grep is a convention check, not proof of coverage; reviewers still read the tests.

## Alternatives considered

- **Mocked database (pglite/in-memory)**: faster but diverges from Postgres triggers and constraints the design relies on.
- **Cypress**: Playwright is pre-installed and supports the multi-origin content host checks.
- **Coverage thresholds**: noisy for agent PRs; scenario ownership is the meaningful metric.
- **Testcontainers**: needs Docker even for Postgres; the compose/`pg-local` pair keeps sessions Docker-free.

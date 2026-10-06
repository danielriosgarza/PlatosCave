# Parallax

A course and class web application: students study five kinds of material per topic (Slides, Reading, Exercises, Notebooks, Tests); instructors author material and review student work. The repository directory is PlatosCave; the product is Parallax.

## Sources of truth

- `docs/product-spec.md` is the canonical specification; `PRODUCT.md` lists the owner's commitments. Do not change product behaviour. If an item cannot be done without changing a commitment, stop and escalate (label `needs-human`).
- `docs/adr/` holds the architecture decisions; follow them. `docs/delivery/plan.md` holds the work breakdown and the exact Phase 0 layout.
- `DESIGN.md` and `docs/wireframe.html` define the visual system and component structure. The wireframe is a demonstration, not production code.

## How work happens here

Work is delivered autonomously: one GitHub issue per plan item, one PR per issue, reviewed by a different model, merged by the orchestrator. Read `docs/delivery/README.md` before any delivery work. Role procedures are skills in `.claude/skills/`: `implement-issue`, `review-pr`, `orchestrate`, `phase-audit`, `steward`.

## Stack

TypeScript 5.9 on Node 22 with pnpm workspaces: Fastify API with zod contracts (`apps/server`, `packages/contracts`), React 19 + Vite + TanStack Router/Query (`apps/web`), design tokens and shared CSS (`packages/ui`), PostgreSQL 16 via drizzle, pg-boss jobs, Vitest and Playwright. Go 1.24 for the compute connector (`connector/`). Details and versions: `docs/adr/0001-technology-stack.md`.

## Commands

Available once Phase 0 (P0-01…P0-03) has merged; Phase 0 items keep this list accurate.

| Task | Command |
| --- | --- |
| Install | `corepack enable && pnpm install --frozen-lockfile` |
| Dev servers | `pnpm dev` (API :3000, web :5173) |
| Lint / format | `pnpm lint` / `pnpm format` |
| Typecheck | `pnpm typecheck` |
| Unit + component tests | `pnpm test` |
| Local Postgres without Docker | `pnpm db:local start` (prints `DATABASE_URL`) |
| Reset local database | `pnpm db:reset` (dev and e2e only: recreates schema `public` in `DATABASE_URL` and migrates) |
| Migrations | `pnpm db:migrate`, `pnpm db:generate` (chain items only) |
| Integration tests | `pnpm test:integration` (needs `DATABASE_URL`) |
| Runner tests | `pnpm test:runner` (Docker-only parts skip locally and run in CI) |
| E2E tests | `pnpm build && pnpm test:e2e` |
| Everything fast | `pnpm check` (lint, typecheck, unit, scenario records) |
| Scenario coverage | `pnpm scenarios` |
| Compose (Docker only) | `pnpm compose …` wraps `docker compose -f infra/compose.yml`; unavailable in cloud sessions |
| Connector | `cd connector && gofmt -l . && go vet ./... && go test ./...` |

## Environment facts

- Cloud sessions have **no Docker daemon**. Use `pnpm db:local` for Postgres. Docker-only suites skip locally and run in CI.
- Playwright is pinned to 1.56.1 to match the pre-installed Chromium (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`). Never run `playwright install` in a session.
- The repository is public, so anything committed (code, issues, PRs, commit metadata) is visible to everyone. Never commit secrets, real credentials or personal data. Still run checks locally before pushing.

## Rules that are easy to break

- **Authorization is structural** (ADR-0002). Every `/api/*` route is registered through `registerRoute` with a contract that declares `scope` and `examples`. Class- and course-scoped data is accessed only through the branded scope objects. Non-members get 404, not 403.
- **Migrations** are added only by the items in the migration chain (plan §0), in order.
- **Tests carry scenario IDs** in their titles (`test('A05 …')`) and every item records covered IDs in `docs/delivery/done/<ID>.txt`. Never mock the database; never skip, delete or weaken a test to get green.
- **UI** uses the `--pc-*` tokens from `packages/ui/src/tokens.css` and ports component CSS from the wireframe. Interface copy states content, actions, audience and real state; explanations of the design belong in docs, not in the UI. Never show "Connected" or "Saved" without a real acknowledgement.
- **Untrusted content** (notebook outputs, SVG, uploads, PDFs and images) is sanitised and served from the separate content origin. The exceptions are three app-origin surfaces: a native reading's ingested HTML, a notebook's Markdown cells and Markdown/LaTeX outputs, and web slides, each rendered on the app origin after two sanitisers with one allow-list (`readingSchema` at ingestion, DOMPurify in the browser, both from `packages/contracts/src/readingHtml.ts`; ADR-0002 §Readings on the app origin). A notebook's HTML and JavaScript outputs stay on the content origin in a `sandbox=""` iframe, cleaned by the separate `outputSchema` in `apps/server/src/content/notebook.ts`.
- Keep each PR inside its issue's scope. New work goes into a new issue.

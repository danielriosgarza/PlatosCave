# ADR 0002 — Authorization and class isolation

**Status:** Accepted, 2026-09-30

Refined by [docs/design/runner.md](../design/runner.md) §8.4 (P3-12): the `execution.run`, `execution.result` and `execution.failed` queues in the separate pg-boss schema `pgboss_exec` carry runner messages without `actorId` or `scope`; authorisation for them completes before `bossExec.send` under a resolved class scope and is repeated on every read. Every queue in `pgboss` keeps the rule below.

## Context

Spec §3 fixes the rule: one account, permissions per membership, and "every content read, media download, result export, and background job checks the relevant course or class scope on the server". §13 requires audience enforcement on annotation reads, private signed media access, and audit events. Scenarios A01, A02, A21 and A33 test that a student cannot reach instructor or classmate data, that one person holding two roles gets only each context's permissions, and that two cohorts of a course are mutually invisible. Because dozens of PRs will add routes, jobs and sockets, the enforcement must be structural: a route that forgets authorization must fail CI, not silently pass.

## Decision

**Principals and memberships.** `users` are identities. Permissions come only from rows in `class_memberships` (`role` ∈ {student, instructor}; boolean grants `manage_members`) and `course_memberships` (grants `owner`, `editor`, `publisher`). Course creation inserts an `owner` course membership. Inviting a class instructor inserts an `instructor` class membership and an `editor` course membership; `publisher` and `manage_members` are separate explicit grants (§3). A student enrolment code can only create `student` rows. **Preview as student** uses a shadow principal: a `users` row with `kind = 'preview'` and `owner_user_id`, holding a `student` membership flagged `is_preview`; its writes live in ordinary tables under that user id, so they can never touch a real student's record, and review/export queries exclude preview users.

**Every route declares a scope.** Contracts in `packages/contracts` require a `scope` field:

```ts
type Scope =
  | { kind: 'public' }                                        // health, sign-in link request
  | { kind: 'user' }                                          // signed-in, own records only
  | { kind: 'class';  role: 'student' | 'instructor' | 'any'; grant?: 'manage_members' }
  | { kind: 'course'; role: 'editor' | 'publisher' | 'owner' }
  | { kind: 'system' };                                       // internal, token-authenticated
```

`registerRoute(app, contract, handler)` is the only way to add an `/api/*` route. A Fastify `onRoute` hook throws at boot when a route under `/api/` lacks `config.scope`, so a hand-registered route fails every test that builds the app. Before the handler runs, the scope resolver reads `classId`/`courseId` from the path, loads the caller's membership in one query, and attaches a branded `ClassScope`/`CourseScope` object (`{ classId, releaseId, membership, role, grants, user }`) to the request. Non-members receive **404**, never 403, so unpublished or foreign resources disclose nothing (§2). Members lacking the role or grant receive 403. Handlers receive the scope object; data-access functions for class- or course-scoped tables accept **only** that branded type, not a raw id, so a handler cannot query another class by passing a string.

**Scoped tables.** Every table holding class data has `class_id NOT NULL` (annotations, threads, attempts, submissions, study positions, notebook sessions, grades, exports); course drafts and releases carry `course_id`. `apps/server/src/db/scoped.ts` lists both sets; a unit test introspects the drizzle schema and fails if a table with such a column is missing from the list or if a scoped table lacks the column. Repository helpers `forClass(scope)` / `forCourse(scope)` add the `WHERE class_id = …` predicate; direct `db.select()` on a scoped table outside `db/` is a lint error (Biome `noRestrictedImports` on the raw client from feature modules).

Data-access files that predate this rule and live outside `db/` (under `auth/`, `content/`, `storage/`, `annotations/` and `jobs/`) take branded scopes and are exempt by name in the `biome.json` override, together with the composition root `main.ts`, until they move under `db/`; test files (`**/*.test.ts`) are exempt too. Every other server file, existing or new, is restricted unless that list names it. The rule is the import restriction plus the GritQL plugin `apps/server/lint/raw-db-query.grit`, whose header lists the forms it does not catch.

**Audience and privacy.** Annotation visibility is computed in one module (`annotations/visibility.ts`): `private` → author only; `instructor` → author plus class instructors; `class` → class members. Every read, count, notification and export uses it. Private notes are never joined into instructor views (§17 default).

**Downloads.** Objects are keyed `courses/{courseId}/…` or `classes/{classId}/…`. A scoped route mints an HMAC content token `{ key, userId, scopeId, exp ≤ 5 min }` only if the key prefix matches its scope. The token is served on a separate **content origin** (`CONTENT_HOST`, e.g. `127.0.0.1` vs `localhost` in dev/e2e, `content.` subdomain in production) that has no cookies and no `/api`, so copied links expire and untrusted HTML (readings, notebook outputs, SVG) cannot read the app session.

**Jobs and sockets.** Every pg-boss payload carries `{ actorId, scope }`; `runScopedJob` re-resolves membership before touching data and rejects payloads without scope. WebSocket upgrades go through a scoped route; the resolved scope is stored on the socket, re-validated every 60 s and on any message naming a resource, and the socket closes on revocation (§14 "Permission revoked").

**Isolation matrix test (A01, A02, A21).** `apps/server/test/fixtures/world.ts` builds course *Statistical thinking* with classes A and B, owner Elena, instructor of B, students in each class, and a user who teaches A and studies in B. Every contract must supply `examples` (valid params/body). The matrix test iterates all registered contracts with `class`/`course` scope and asserts: foreign principal → 404; correct class but wrong role → 403; preview principal never reaches instructor routes. New routes are covered automatically; a route without examples fails the test. Scenario tests for A33 extend the same harness to notebook sessions and forwarding destinations (ADR-0005).

**Audit.** Membership and grant changes, publication, adoption, assignment changes, submissions, grade overrides, releases and exports append to `audit_events` (actor, target, scope, before/after summary). Sensitive membership changes require `auth_time` within 15 minutes (§3), enforced in the resolver via `scope.requireRecentAuth()`.

## Consequences

- Adding a feature means adding a contract with scope and examples; forgetting either breaks boot or the matrix test.
- 404-for-non-members hides existence but can confuse debugging; logs record the real reason at debug level only.
- The shadow preview user adds rows per instructor per class; it keeps every other table simple.
- Two hostnames are needed in every environment (dev: `localhost` + `127.0.0.1`; prod: two subnames); documented in Phase 0/P1-06.
- Postgres row-level security is not used initially; the schema keeps `class_id` on every scoped table so RLS policies can be added later as defence in depth without changing queries.

## Alternatives considered

- **Row-level security as the primary control**: strongest at the database, but policies per table, per-request `SET LOCAL`, bypass roles for jobs, and "why is my query empty" debugging are costly for agent-authored PRs. Deferred to hardening.
- **Ability libraries (CASL)**: flexible but encourages per-handler checks, which is precisely what can be forgotten.
- **Per-handler `assertMember()` calls**: no structural guarantee; rejected.
- **Presigned bucket URLs**: simpler streaming, but leaks long-lived links and couples the app to S3 semantics; token-gated streaming keeps `fs` and `s3` adapters identical.

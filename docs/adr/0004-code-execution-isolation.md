# ADR 0004 — Code execution isolation for Tests

**Status:** Accepted, 2026-09-30

Refined by [docs/design/runner.md](../design/runner.md) (P3-12): the job reaches the sandbox over stdin and the result returns over stdout rather than through `/work`, the harness is baked into the image, and the runner's queues live in their own pg-boss schema `pgboss_exec`. Where the two disagree, the design document is current.

## Context

Student code runs in "a disposable isolated worker, separate from the application and its database credentials", with networking disabled, filesystem and processes restricted, caps on CPU, memory, wall time, output size and concurrent runs, and the environment destroyed after each job (§11). Defaults: 10 s wall time, 512 MiB, 1 MiB output, two active runs per student, approved versioned Python/R images; course overrides have server-enforced upper bounds. Execution records bind student, attempt, question revision, code hash, image, grader version and job id; infrastructure failure yields **Run unavailable · Retry** without consuming an attempt (A18). Hidden checks never reach the browser (A12); hostile code cannot reach platform credentials (A13). The secure execution service is required independently of notebook connections (§10.7). Cloud sessions have no Docker daemon; CI (GitHub-hosted Ubuntu) and developer machines do.

## Decision

**Components.**

- `apps/server` enqueues `execution.run` jobs (pg-boss) with an inline bundle ≤ 2 MiB: student files, the test set to run (`public` or `hidden`), runtime config within bounds, and identifiers. It writes the `execution_jobs` row (state `queued`) and, on completion, copies the job output into `execution_results`. Students only ever read `execution_results` through contracts whose response schema has no hidden-check fields.
- `apps/runner` is a separate package and container with **its own Postgres role** (`parallax_runner`) granted only on the `pgboss` schema; it cannot read application tables or storage. It holds no `SESSION_SECRET`, no storage credentials and no outbound network except Postgres. It runs one pg-boss worker per configured slot (`RUNNER_SLOTS`, default 4).
- **Executor**: dockerode against the runner host's Docker daemon (`DOCKER_HOST` or socket). Per job: create container from the pinned image digest, `putArchive` the bundle plus harness into `/work`, start, stream stdout/stderr with a 1 MiB cap (marking `truncated`), wait with a wall-time timer that kills the container, `getArchive` `/work/result.json`, then `remove(force)`. Nothing from the container is trusted except the parsed result JSON validated by zod.
- **Container policy** (built in one pure function `buildHostConfig(limits)`, unit-tested field by field): `NetworkMode: 'none'`, `ReadonlyRootfs: true`, `Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m', '/work': 'rw,nosuid,size=64m' }`, `Memory` and `MemorySwap` both = limit (no swap), `PidsLimit: 64`, `NanoCpus: 1e9`, `CapDrop: ['ALL']`, `SecurityOpt: ['no-new-privileges']`, `User: 'runner'` (uid 10001 baked into the image), `Init: true`, no volumes, no environment variables except `PARALLAX_JOB=1`. Production sets `Runtime: 'runsc'` (gVisor) through `RUNNER_DOCKER_RUNTIME`; local and CI use the default runtime and are still subject to all the above. Seccomp uses Docker's default profile.
- **Images** live in `runner/images/<lang>/Dockerfile`: `parallax-runner-python` from `python:3.12-slim` with a pinned package set (numpy, pandas, scipy per course allowlist) and `parallax-runner-r` from `rocker/r-ver:4.6.1`. Images are built in CI, tagged by content hash, and referenced by digest in `execution_results.image_digest`. Package installation by student code is impossible (no network, read-only root).
- **Harness contract** (`runner/harness/<lang>/`): the harness reads `/work/job.json` (files, entry, checks), runs each check in a fresh subprocess with the remaining wall budget, and writes `/work/result.json`: `{ harnessVersion, checks: [{ name, status: passed|failed|error|timeout, expected?, actual?, message? }], stdout, stderr, truncated, durationMs }`. Check kinds: `stdin/stdout` (input, expected output, comparison mode exact|trimmed|numeric-tolerance) and `call` (a small driver expression evaluated by the harness, as in the wireframe's `FAIL [2, 4, 6, 8] Expected 1.290994 Received None`). Exact schemas are fixed by the runner design item (P3-12).
- **Job states**: `queued → running → passed | failed | time_limited | resource_exhausted | cancelled | infrastructure_error`. Only `infrastructure_error` (daemon unreachable, image pull failure, harness crash without result) is retried by pg-boss (3 attempts, backoff) and never consumes an attempt or counts toward the per-student cap. The per-student active-run cap (2) and course limit bounds are enforced in `apps/server` before enqueueing.
- **Execution records** bind `(user_id, attempt_id?, question_revision_id, code_hash, image_digest, harness_version, grader_version, job_id)`; regrading creates a new result row with `reason`, never overwrites. Sample-test results shown in the UI reference `code_hash`; the editor marks output stale when the current hash differs (A12).

**Environments.**

| | Local dev | CI (PR) | Production |
| --- | --- | --- | --- |
| Docker | developer's daemon; `pnpm runner:dev` | GitHub-hosted runner daemon; job `runner` | dedicated runner host/VM with its own daemon, gVisor runtime |
| Network boundary | same machine | same VM | runner host reaches Postgres (pgboss schema) only; API host has no Docker socket |
| Tests | `*.docker.itest.ts` skip when no daemon | mandatory | smoke job on deploy |

**Tests for A13** (run in CI against the real executor): infinite loop → `time_limited` within 10 s + 2 s; allocation of 1 GiB → `resource_exhausted`; `fork()` bomb → pids limit, job ends `failed`; `socket.connect` to 1.1.1.1:80 and DNS lookup → error, no route; reading `/etc/shadow`, writing `/usr` → permission errors; reading environment → no secrets; 10 MiB print → `truncated` at 1 MiB; two concurrent runs accepted, third rejected at the API with 429 and a queue message.

## Consequences

- The runner is a second deployable with a tiny surface; it shares `packages/contracts` for result schemas only.
- Cloud sessions cannot execute the Docker suites; the worker's state machine and policy builder are pure and unit-tested so most logic is still verified locally.
- gVisor is a production-only difference; the same policy applies in both, which keeps CI meaningful.
- Inline bundles cap starter files at 2 MiB; larger datasets are a later feature (bundle by signed download from the API).

## Alternatives considered

- **nsjail / bubblewrap in-process**: no Docker dependency but Linux-only, harder to reason about for agents, and CI/prod parity is worse.
- **Firecracker microVMs**: strongest isolation; operationally heavy for a single-organisation pilot; gVisor gives most of the benefit with one config flag.
- **Kubernetes Jobs**: ties the product to a cluster before hosting is chosen.
- **External judge services (Judge0, Piston)**: a third-party dependency for hidden tests and student code; unacceptable for the privacy requirements in §13.

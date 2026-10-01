# Runner detailed design (P3-12)

**Status:** accepted with the merge of P3-12, 2026-10-01. Refines [ADR-0004](../adr/0004-code-execution-isolation.md) for §11 of the [product specification](../product-spec.md). The normative machine-readable parts are the JSON Schemas in [`runner/protocol/v1/`](../../runner/protocol/v1/); this document explains them and fixes everything the schemas cannot: the harness behaviour, the container policy, limits and bounds, the per-student cap, replay and regrade, production placement and network policy. Items P3-13, P3-14, P3-16 and P4-11 in [the plan](../delivery/plan.md) implement it and name their tests from §12 below.

Terms: a **run** is one execution request for one code question and one code snapshot. A **job** is the document the server enqueues for it. A **check** is one test case inside a job. The **harness** is the program inside the sandbox that runs the checks and reports a **result**. The **runner** is the trusted service (`apps/runner`) that turns jobs into containers and results into an **outcome**.

## 1. Components and trust boundaries

```
 browser ──HTTPS──▶ apps/server (api) ──INSERT execution_jobs; bossExec.send('execution.run', job)──▶ Postgres ┐
                    apps/server (worker) ◀──bossExec.work('execution.result'), work('execution.failed')──────┤ schema pgboss_exec
                                                                                                             │
 runner host:       apps/runner (role parallax_runner, schema pgboss_exec only) ◀──fetch / send result / complete─┘
                        │ dockerode: create ▸ attach ▸ start ▸ stdin: nonce line + job JSON + EOF ▸ wait ▸ inspect ▸ remove
                        ▼
                    sandbox container (NetworkMode none, read-only root, tmpfs /work /tmp, uid 10001)
                        python3 /opt/parallax/harness/run.py  ──▶ one nonce-framed result document on stdout
                            └─ per check: materialise the check's files into /work/c<N> ▸ subprocess (python3 | Rscript) ▸ compare ▸ remove
```

| Component | Trusts | Is trusted for |
| --- | --- | --- |
| `apps/server` | its own tables; `RunnerOutcome` only after zod validation | authorisation (ADR-0002), the per-student cap, limit clamping, which checks and files a student may see |
| Postgres schema `pgboss_exec` | — | the only channel between server and runner, in both directions: queues `execution.run`, `execution.result` and the dead-letter queue `execution.failed` |
| `apps/runner` | job payloads from the queue after zod validation; the Docker daemon | enforcing the container policy, re-clamping limits, allowlisting images, classifying outcomes |
| sandbox container, harness | nothing from outside except what arrives on stdin | nothing: its stdout is parsed, validated and bounded before any field is used |
| student code | — | nothing; it can only influence its own result's `passed`/`failed`/`error` fields |

The job payload carries **no user, class, attempt or course identifiers**, only `jobId` (ADR-0004 §Components). The runner's database role has privileges in `pgboss_exec` only: a compromised role can read the jobs waiting there (student code and checks, without names) and the outcomes, and can enqueue runs and results, and nothing else. It has no privilege on the application tables or on the application's own `pgboss` schema, so it cannot read the scoped jobs of P1-07, whose payloads name an actor, nor enqueue one; `a13-runner-role.itest.ts` asserts both (§10.3). Injected or forged results are bounded by what the server does with an outcome: it writes a result row for the named job and never changes an attempt's state or grade from it directly (P4-01 reads results through its own rules).

## 2. Life of a run

1. **Request.** A student clicks Run sample tests. The client autosaves the editable files and `POST`s them to `/api/classes/:classId/attempts/:attemptId/questions/:questionId/runs`. The route runs under class scope (role student, own attempt).
2. **Snapshot and reuse.** The server computes `codeHash` (§8.2). If this attempt already has a terminal result for (`attemptId`, `questionId`, `codeHash`, `set: 'public'`, `graderVersion`) whose status is not `infrastructure_error`, it answers `200` with that run and `reused: true`: identical code gives identical output, a slot is saved, and the record still binds this student, this attempt and the hash (spec §11, A12). Runs of other attempts or students are never reused, so every run a student sees is one of their own.
3. **Cap.** Inside one transaction with `pg_advisory_xact_lock(hashtext('execution:' || userId))`, the server counts this user's `execution_jobs` with `reason = 'sample'` in `queued` or `running`. Two or more: `429 { error: 'too_many_runs', active: 2, message: 'Two runs are already queued or running. Wait for one to finish.' }`. A queued sample run for the same question is cancelled first (`supersededBy`), so a student iterating quickly never queues behind their own stale code.
4. **Enqueue.** The server inserts the `execution_jobs` row (`state queued`), builds the job with `buildRunnerJob` (§8.2), and `bossExec.send('execution.run', job, { priority, expireInSeconds: wallSeconds + 60, retryLimit: 3, retryDelay: 5, retryBackoff: true })` on the execution pg-boss instance (§8.4). It stores the pg-boss id in `boss_job_id` and answers `202 { runId, state: 'queued', queuePosition }`.
5. **Fetch.** One of the runner's slots fetches the job. The runner validates it with `RunnerJob` and the semantic rules of §3.1, re-clamps limits, resolves the image (§6.4), creates the container with `buildContainerConfig(job, image)` (§7.3), attaches to stdin, stdout and stderr, starts it, writes the 32-hex nonce, a newline and the job JSON to stdin, closes stdin, and arms the kill timer at `wallSeconds + 5 s`. Nothing is uploaded to or mounted into the container.
6. **Harness.** Inside the container the harness reads the nonce and the job from stdin and keeps the job in memory only, makes itself non-dumpable, parses the student's files (compile phase), and for each check materialises the files that check may see into a fresh directory, runs it in a subprocess with the remaining wall budget, compares, and removes the directory. It then prints one framed result document (§4.4) and exits 0.
7. **Collect.** The runner waits for exit, inspects `State.OOMKilled`, extracts the framed result from stdout, validates it with `RunnerResult`, classifies (§7.4) and removes the container. It sends the outcome as an `execution.result` message (`singletonKey: jobId`) and then completes its `execution.run` job with the same outcome as output. Infrastructure problems fail the pg-boss job instead; after the retries, or at once for terminal kinds, pg-boss moves it to the dead-letter queue `execution.failed` (§7.5).
8. **Record.** The server worker consumes `execution.result`: it inserts the `execution_results` row, moves `execution_jobs.state` to the outcome's status, and copies `startedOn` and `retryCount` from the pg-boss job. `execution.failed` messages become `infrastructure_error`. The API's `GET …/runs/:runId` returns the student view (§8.6): status, public checks with expected/actual/message, the code hash, and never a hidden check; while the row is not terminal it reports `queued` or `running` from the pg-boss job's state.
9. **Stale.** The editor compares the result's `codeHash` with the hash of the current editor content and labels the output out of date when they differ (A12).

A grading run (step 4 with `set: 'full'`, `reason: 'grading'`) is enqueued by the submission flow, not by the student, and is read only by instructors and the grading item.

## 3. Protocol v1

Files: [`job.schema.json`](../../runner/protocol/v1/job.schema.json), [`result.schema.json`](../../runner/protocol/v1/result.schema.json), [`examples/`](../../runner/protocol/v1/examples/). P3-13 mirrors them as zod schemas in `packages/contracts/src/runner.ts` (`RunnerJob`, `RunnerResult`, `RunnerOutcome`, `RUNNER_BOUNDS`, `clampLimits`, `validateJob`) with a test that parses every example in `examples/`, rejects every file under `examples/invalid/` (fails the JSON Schema) and rejects every file under `examples/rejected/` (passes the JSON Schema but breaks a semantic rule below). Each invalid or rejected fixture breaks exactly one rule, so a mirror that misses a rule fails on a named file. The Python harness tests (P3-14) read the same fixtures. JSON Schema's `format: uuid` is an annotation in draft 2020-12; the zod mirror asserts it. A change to either schema is a protocol change: bump `v`, keep the old file, and have the runner accept both until no server sends the old one.

### 3.1 Job

| Field | Meaning |
| --- | --- |
| `v` | `1` |
| `jobId` | `execution_jobs.id`; echoed in the outcome so the server can match it |
| `runtime.id` | approved runtime, `python-3.12` or `r-4.6`; the runner maps it to an image |
| `runtime.language` | `python` or `r`; selects the harness branch |
| `runtime.image` | only for replays: the exact image the original run used, as a repository digest (`repo@sha256:…`) or a Docker image id (`sha256:…`) (§9) |
| `set` | `public` (student-triggered; only public checks and non-hidden files are present) or `full` (every check and file) |
| `limits` | `wallSeconds`, `memoryMiB`, `outputBytes`, clamped by the server to §5 and clamped again by the runner |
| `files[]` | `path`, `content`, `encoding` (`utf8` default or `base64`), `hidden` (default false); the question's starter files overlaid by the student's editable files; at most 64 files and 2 MiB decoded |
| `checks[]` | 1 to 50 checks, names unique, order significant; `files[]` on a check lists additional hidden files it needs |

Paths are relative, at most 200 characters, every segment starting with a letter, digit or underscore (so `.`, `..`, dotfiles and absolute paths are unrepresentable).

**Semantic rules** the schema cannot express, enforced by `validateJob` in the server (before sending), in the runner (terminal `job_invalid`) and in the harness (exit 64), each with a fixture under `examples/rejected/`:

1. check names are unique (results are matched to checks by name);
2. a job with `set: 'public'` contains no hidden check and no hidden file;
3. every path a check names (`file`, `files[]`) is in `files`, and a public check names no hidden file;
4. paths are unique after normalisation and the decoded size of all files is at most 2 MiB (the serialised job at most 4 MiB).

**Check kinds**

| Kind | Runs | Passes when |
| --- | --- | --- |
| `stdio` | `file` as a program (`python3 -I -B file args…` or `Rscript --vanilla file args…`) with `stdin` | exit code equals `expected.exitCode` (default 0) and stdout compares equal to `expected.stdout` under `compare` |
| `call` | the language driver loads `file`, calls `function` with JSON `args` and `kwargs` | `expected.value` compares equal to the returned value under `compare`, or the call raises an exception matching `expected.raises` |
| `script` | an author-written test program `file` with `args` and `stdin` | exit code 0; anything else is `failed` with the last line of stderr as the message |

**Comparison modes** (`compare.mode`; `abs` defaults to 1e-6 and `rel` to 1e-9; a number `a` matches `b` when `|a − b| ≤ abs + rel·|b|`)

| Mode | For | Rule |
| --- | --- | --- |
| `exact` | stdio, call | stdio: the decoded texts are identical. call: the JSON serialisations are structurally equal (`1` equals `1.0`; tuples are lists) |
| `trimmed` | stdio | trailing whitespace removed from every line, trailing blank lines removed, then identical |
| `tokens` | stdio | whitespace-separated token sequences identical |
| `numeric` | stdio, call | stdio: token sequences of equal length where numeric tokens match within tolerance and other tokens are identical. call: recursive structural equality where numbers match within tolerance |
| `repr` | call | the language's `repr` (Python) or `deparse` (R) of the value equals the string `expected.value` |

`expected.raises.type` is matched against the raised exception's class and its bases in Python (`ValueError`), and against the condition classes in R (`error` matches any error). `message`, when given, is a regular expression searched in the message. A `call` check that expects a value and gets an exception is `error`/`exception`, not `failed`; a check that expects an exception and gets a value is `failed` with `actual: 'returned <repr>'`, which is the wireframe's `Expected: ValueError` case.

`job-sample-python.json` and `job-full-python-replay.json` are the `public` and `full` jobs of the same question: the public one carries the editable `solution.py` and the public `data/sample.csv`, the full one adds the hidden `tests/hidden_test.py` and the two hidden checks.

### 3.2 Result

One entry per job check, in job order. Statuses:

| Status | Meaning | Job status it implies (§7.4) |
| --- | --- | --- |
| `passed` | ran and compared equal | — |
| `failed` | ran and compared different, or a script exited non-zero | `failed` |
| `error` | did not reach a comparison; `errorKind` says why: `exception` (uncaught, call checks), `exit` (unexpected exit code), `signal`, `memory` (killed while the cgroup counted an out-of-memory kill), `spawn` (could not start, for example the pids limit), `harness` | `failed`, except `memory` → `resource_exhausted` |
| `timeout` | killed at its time cap | `time_limited` |
| `skipped` | not run: compile error, or the wall budget was already spent | `failed` |

`expected`, `actual` (≤ 2048 characters, cut with `…`) and `message` (≤ 512) are what the UI shows per public check, in the wireframe's form `FAIL [2, 4, 6, 8] · Expected: 1.290994 · Received: None`. `stdout`/`stderr` are the check's captured streams, each bounded by what remains of the job's `outputBytes` (§4.3), `truncated` when cut. `compileError` (`file`, `line`, `message`) is present when a file did not parse; every check is then `skipped`, so a syntax error is shown as a compile error distinctly from a runtime error (`error`/`exit` with the traceback in `stderr`), as spec §11 requires. `runtime.version` is the interpreter's own version string; `harnessVersion` is the integer version of `runner/harness`.

### 3.3 Outcome (runner → server, zod only)

```ts
RunnerOutcome = {
  v: 1, jobId,
  status: 'passed' | 'failed' | 'time_limited' | 'resource_exhausted',
  image: { ref: string; id: string; digest: string | null },      // docker Id, RepoDigests[0]
  container: { exitCode: number | null; oomKilled: boolean; killedByTimer: boolean; durationMs: number },
  result: RunnerResult | null,   // null only with oomKilled or killedByTimer
  harnessLog: string,            // container stderr tail, ≤ 8 KiB; never student output
}
```

The outcome travels twice: as the `execution.result` message the runner sends, and as the output of the completed `execution.run` job (for operators). Infrastructure problems are not outcomes. The runner fails the pg-boss job with `{ kind, message }`, `kind` ∈ `daemon_unreachable`, `image_unavailable`, `image_not_allowed`, `job_invalid`, `harness_failed` (non-zero exit without OOM or timer), `result_missing`, `result_invalid`. `image_not_allowed` and `job_invalid` are terminal (`deadletter` in pg-boss's per-job results); the others are retried up to three times with backoff, then terminal. Terminal failures land on the dead-letter queue `execution.failed`, which the server consumes (§8.5) and shows as **Run unavailable · Retry**.

## 4. Harness

### 4.1 One harness, two languages

`runner/harness/run.py` is stdlib-only Python 3 and is the harness for both images: the R image installs `python3` from its Ubuntu base for this purpose. Language-specific work is confined to two small drivers, `driver.py` and `driver.R`, and a command table:

| | python | r |
| --- | --- | --- |
| compile phase | `python3 -I -B -c 'import ast,sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])' FILE` for every non-hidden `*.py` | `Rscript --vanilla -e 'invisible(parse(commandArgs(TRUE)[1]))' FILE` for every non-hidden `*.R`/`*.r` |
| stdio | `python3 -I -B FILE ARGS` | `Rscript --vanilla FILE ARGS` |
| call | `python3 -I -B /opt/parallax/harness/driver.py` | `Rscript --vanilla /opt/parallax/harness/driver.R` |
| script | `python3 -I -B FILE ARGS` | `Rscript --vanilla FILE ARGS` |
| interpreter version | `python3 --version` | `Rscript -e 'cat(R.version$major, R.version$minor, sep=".")'` |

One implementation means one test suite, one version number and no base-R JSON parsing. `jsonlite` is used only inside `driver.R`.

### 4.2 Start-up

1. Read stdin to EOF with a 10 s `select` timeout and a 4 MiB cap: the first line is the nonce (`^[0-9a-f]{32}$`), the rest is the job JSON. A missing or malformed nonce, a timeout, an oversize stream, or a job that fails the structural check (`v`, `runtime.language`, `files`, `checks`, `limits`) or a semantic rule of §3.1 → exit 64 without output. Then close fd 0 and reopen `/dev/null` on it so children never inherit the container's stdin.
2. `prctl(PR_SET_DUMPABLE, 0)` via `ctypes`. From now on no same-uid process can open `/proc/<harness pid>/fd/*`, `environ` or `mem`, so student code cannot write to the harness's stdout pipe or read the job, which exists only in the harness's memory and is never written to disk. (Children are fresh `exec`s and are dumpable again, which is irrelevant.)
3. Compile phase: the non-hidden files are materialised into `/work/compile/`, each is parsed in a subprocess with a 5 s cap inside the budget, and the directory is removed. The first failure fills `compileError` and marks every check `skipped` with `message: 'Not run: <file> does not compile'`. Hidden files are the author's and are validated at publication, not here.

### 4.3 Running a check

For each check in order, while `remaining = wallSeconds − elapsed > 0`:

- **Materialise.** `/work/c<N>/` receives the files this check may see: every file with `hidden: false`, plus, for a hidden check only, the hidden files it names in `file` and `files[]`. The check runs with that directory as cwd. Public checks therefore never have a hidden file on disk, and a hidden check sees only the hidden files it declared; what a public check prints can be shown to the student without leaking hidden material (§8.6, §11). The directory is removed when the check ends, so `/work` holds one check at a time.
- **Process.** `subprocess.Popen` with the command from §4.1, `start_new_session=True` (its own process group), `stdin` = the check's `stdin` (empty by default), pipes for stdout and stderr, and `preexec_fn` setting `RLIMIT_FSIZE` to 32 MiB, `RLIMIT_CORE` to 0 and `RLIMIT_NOFILE` to 256.
- **Environment.** Exactly: `PATH=/usr/local/bin:/usr/bin:/bin`, `HOME=/tmp`, `TMPDIR=/tmp`, `LANG=C.UTF-8`, `LC_ALL=C.UTF-8`, `PARALLAX_JOB=1`, `PYTHONHASHSEED=0`, `PYTHONDONTWRITEBYTECODE=1`, `PYTHONIOENCODING=utf-8`, `OMP_NUM_THREADS=1`, `OPENBLAS_NUM_THREADS=1`, `MKL_NUM_THREADS=1`, and for R `R_LIBS_USER=/tmp/none`. Nothing is inherited.
- **Capture.** Two reader threads drain the pipes incrementally. Each stream keeps at most `outputBytes − bytes kept so far in this job` and sets `truncated` beyond that; reading continues (bytes are discarded) so the child never blocks on a full pipe and a 10 MiB print finishes normally, cut at 1 MiB with the default limit. Text is decoded as UTF-8 with replacement characters.
- **Time.** The cap is `min(check.timeoutSeconds ?? remaining, remaining)`. On expiry the harness sends `SIGKILL` to the process group, records `timeout`, and marks every later check `skipped` with `message: 'Not run: time budget spent'`. The harness waits for the process group to end before continuing, so stray grandchildren cannot outlive the check (a daemonised process that escapes its group is bounded by the container and killed before the result is written, §4.4).
- **Memory.** Before and after the check the harness reads the `oom_kill` counter from `/sys/fs/cgroup/memory.events` (cgroup v2) or `/sys/fs/cgroup/memory/memory.oom_control` (v1); unreadable counters count as zero. A child that died by `SIGKILL` while the counter rose is `error`/`memory` with `message: 'Killed: memory limit of <n> MiB exceeded'`. If the harness itself is the victim, the container exits with `OOMKilled: true` and the runner classifies the job (§7.4) without a result.
- **Spawn failure** (`EAGAIN` from a saturated pids limit, `ENOENT`, `ENOSPC` while materialising) is `error`/`spawn`.
- **Comparison** per §3.1, performed by the harness, never by the driver (§4.5). `expected` and `actual` are rendered as JSON for values, as the raw text for stdio (cut to 2048 characters), and as `Type: message` for exceptions. `message` is one line: `Expected 1.290994, received None`, `Line 2 differs`, `Exited with code 1`, `Expected ValueError, but the call returned None`.

### 4.4 Result framing

After the last check the harness sends `SIGKILL` to every process it may signal (`os.kill(-1, SIGKILL)`, which spares pid 1 and itself), reaps children (`waitpid(-1, …)` until `ECHILD`), and only then writes the result, so no leftover process can interleave bytes with it. It writes nothing to stdout except the result, framed by the nonce:

```
--parallax-result <nonce>
{ …one-line JSON… }
--parallax-end <nonce>
```

Its own diagnostics go to stderr (kept by the runner as `harnessLog`, ≤ 8 KiB). The runner accepts a result only when the container exited 0 and exactly one well-formed frame with the job's nonce is present; any other bytes on stdout are ignored (and logged). Student processes cannot reach the harness's stdout (§4.2 step 2) and do not know the nonce (it is consumed from stdin before any student code runs and lives only in the non-dumpable harness's memory), so a forged or corrupted result cannot be accepted; killing the harness only produces `harness_failed`. Exit codes: 0 result written; 64 bad input (nonce or job); 70 internal fault. With `ReadonlyRootfs` and tmpfs mounts no file survives the container's exit, and Docker refuses to copy files into a read-only container at all, which is why both the job and the result travel over the attached standard streams rather than through `/work` as ADR-0004 sketched (§13).

### 4.5 Call driver protocol

The harness starts the driver with the call specification as the first line of its stdin (`{ file, function, args, kwargs, outcomePath }`), followed by the check's `stdin` for the student function to read. The driver never receives `expected` or `compare`: the comparison happens in the harness, so neither the driver's memory nor its stdin is an oracle for the code under test. The driver adds the working directory to the module path (`sys.path.insert(0, cwd)`; `source(file, local = env)`), resolves `function` (dotted names allowed for Python attributes), calls it, and writes one JSON document to `outcomePath` (a harness-chosen file under `/tmp`): `{ ok: true, value }` or `{ ok: false, exception: { type, bases: [...], message } }`. Values are serialised as JSON when possible (tuples as lists, `NaN`/`Infinity` as the strings `"NaN"`, `"Infinity"`, `"-Infinity"`; R atomic vectors of length 1 unboxed, longer ones as arrays, named lists as objects) and otherwise as `{ "repr": "<repr>" }`, which `exact` compares as a string and `repr` mode compares directly. The student's own stdout and stderr are the process's streams and are captured as for any check. A student process can overwrite its own outcome file; that is equivalent to returning the expected value and is not a privilege the sandbox tries to remove: hidden checks, `script` checks and instructor review are the controls against cheating, the sandbox is the control against escape (§11).

### 4.6 Versioning

`harnessVersion` is bumped whenever a result can differ for the same job (comparison semantics, environment, capture caps, driver serialisation). It is baked into the image label `org.parallax.harness` and reported in every result; the server includes it in `graderVersion` (§8.2), so a harness change never silently regrades.

## 5. Limits and bounds

Server-enforced bounds (`RUNNER_BOUNDS` in `packages/contracts/src/runner.ts`, used by `clampLimits` on both sides):

| Limit | Default | Minimum | Maximum | Course override |
| --- | --- | --- | --- | --- |
| `wallSeconds` (whole harness budget) | 10 | 1 | 60 | per question, within bounds |
| `memoryMiB` (container `Memory`, no swap) | 512 | 64 | 2048 | per question, within bounds |
| `outputBytes` (captured stdout+stderr, all checks together; one check may use all of it) | 1 MiB | 4 KiB | 4 MiB | per question, within bounds |

Fixed, not overridable: 1 CPU (`NanoCpus: 1e9`), 64 pids, `/work` and `/tmp` tmpfs 64 MiB each (`noexec,nosuid,nodev`; `/work` holds one check's files at a time), `RLIMIT_FSIZE` 32 MiB per process, files ≤ 2 MiB decoded and ≤ 64, serialised job ≤ 4 MiB, ≤ 50 checks, `stdin` and `expected.stdout` ≤ 256 KiB, `expected`/`actual` ≤ 2048 characters, container kill timer `wallSeconds + 5 s`, pg-boss `expireInSeconds = wallSeconds + 60`, three infrastructure retries.

Per-student cap: **2** sample runs `queued` or `running` per user across all classes (§2 step 3). Grading, replay, regrade and preview runs do not count against it and are not capped per user. Priorities: sample runs 10, preview runs 10, grading runs 5, replay and regrade 0, so an interactive student never waits behind a bulk regrade and a class of 200 submitting together drains in priority order with a visible queue position. pg-boss fetches `priority DESC, created_on ASC`, so `queuePosition` = jobs on `execution.run` in `created`/`retry` with a higher priority, whatever their creation time, plus those with the same priority created earlier.

The runner clamps once more and refuses (terminal `job_invalid`) a job that exceeds a bound after clamping, so a bug in the server cannot ask for more than the policy allows.

## 6. Images

### 6.1 Layout and contents

```
runner/
├── protocol/v1/            job.schema.json  result.schema.json  examples/  examples/invalid/  examples/rejected/
├── harness/                run.py  driver.py  driver.R  test_run.py  (one version number in run.py)
└── images/
    ├── python/Dockerfile   requirements.txt
    └── r/Dockerfile
```

| Runtime id | Base image (pinned by digest) | Adds |
| --- | --- | --- |
| `python-3.12` | `python:3.12-slim@sha256:…` | `requirements.txt` installed with `pip install --no-cache-dir --require-hashes` (versions and hashes read from PyPI on the day): `numpy`, `pandas`, `scipy`; user `runner` uid/gid 10001 with home `/tmp`; harness at `/opt/parallax/harness/` (root-owned, 0755) |
| `r-4.6` | `rocker/r-ver:4.6.1@sha256:…` | `python3` from the Ubuntu base (apt, pinned by the base digest) for the harness; `jsonlite` from the image's frozen CRAN snapshot; the same user and harness |

Images have no shell entrypoint, no package managers reachable at run time (network is off and the root is read-only, so `pip install` and `install.packages` cannot work), no setuid binaries (`find / -perm -4000` is empty, asserted by an image test), and these labels: `org.opencontainers.image.revision` (git sha), `org.parallax.runtime` (runtime id), `org.parallax.harness` (harness version), `org.parallax.content-hash` (§6.2). `allowedPackages` on a question is informational for students and a publication-time check (every named package must be in the runtime's package list, §8.1); the image cannot and does not restrict imports.

### 6.2 Pinning and tags

`scripts/runner-image.sh hash <lang>` prints the SHA-256 of the sorted contents of `runner/images/<lang>/` and `runner/harness/`; `scripts/runner-image.sh build <lang>` builds `parallax-runner-<lang>:<hash>` and tags it `:dev`. CI builds the image on every PR in the `runner` job and uses it by tag; nothing is pushed from CI. Production images are pushed to the organisation's registry by the deploy pipeline (§10) and referenced by **digest** everywhere: in `RUNNER_RUNTIMES` on the server, in `RUNNER_IMAGES` on the runner, in `execution_results.image_digest`. In development and CI, where no registry exists, `digest` is null and the Docker image id (`sha256:…`) stands in for it; both are stored and shown, and a replay pins whichever the original run recorded (§9).

### 6.3 Approved runtimes (server)

`RUNNER_RUNTIMES` (JSON array) lists what questions may select:

```json
[{ "id": "python-3.12", "language": "python", "image": "parallax-runner-python:dev", "digest": null,
   "harnessVersion": "1", "packages": ["numpy", "pandas", "scipy"] }]
```

Production configuration requires `digest`. Test authoring offers only these ids; publication validation rejects a question whose runtime is not listed.

### 6.4 Image allowlist (runner)

`RUNNER_IMAGES` maps a runtime id to the image references the runner may run, newest first: `{ "python-3.12": ["ghcr.io/…/parallax-runner-python@sha256:aaa…", "ghcr.io/…@sha256:999…"] }` in production, `{ "python-3.12": ["parallax-runner-python:dev"] }` in development and CI. At start-up, and again whenever a job names an image it does not know, the runner inspects every allowlisted reference and records its `Id` and `RepoDigests`. A job without `runtime.image` runs on the first entry. A job with it runs only when the value equals an allowlisted reference, or the `Id`, or one of the `RepoDigests` of an allowlisted reference; otherwise `image_not_allowed`. Older digests stay listed as long as replays against them should still work; in development a rebuilt `:dev` image changes its id, so a replay of a run made with the previous build ends `image_unavailable` and the instructor regrades instead (§9). `RUNNER_PULL=never` (production default) means a missing image is `image_unavailable`, never a pull at job time; `RUNNER_PULL=missing` lets development and CI pull or use a locally built tag.

## 7. Runner service (`apps/runner`)

### 7.1 Configuration

| Variable | Meaning |
| --- | --- |
| `RUNNER_DATABASE_URL` | connection as role `parallax_runner`, which has privileges in schema `pgboss_exec` only (§10.3); required |
| `RUNNER_SLOTS` | concurrent containers, default 4 (1–32); one pg-boss `work()` registration per slot with `batchSize: 1`, `pollingIntervalSeconds: 1`, `perJobResults: true` |
| `RUNNER_IMAGES` | §6.4; required |
| `RUNNER_PULL` | `never` (default) or `missing` |
| `RUNNER_DOCKER_RUNTIME` | optional OCI runtime name, `runsc` in production |
| `DOCKER_HOST` | optional; dockerode's default socket otherwise |
| `LOG_LEVEL` | pino level |

`config.test.ts` asserts the schema has exactly these keys: the runner has no `SESSION_SECRET`, no storage, mail or content configuration, and no application `DATABASE_URL`.

### 7.2 Start-up and shutdown

pg-boss is created with `schema: 'pgboss_exec'`, `migrate: false`, `supervise: false`, `schedule: false` on a pool of at most `RUNNER_SLOTS + 2` connections. `start()` then only reads `pgboss_exec.version`; if the schema or the queues do not exist yet (the server creates them, §8.4), the runner logs and retries every 10 s. Before working it removes containers labelled `parallax.runner=1` left by a crash, pings the daemon and resolves the image allowlist (§6.4). On `SIGTERM` it stops fetching, waits for running containers up to the longest wall limit + 10 s, and exits; pg-boss expiry covers anything that did not finish.

### 7.3 Container policy

`buildContainerConfig(job, image)` and `buildHostConfig(limits, runtime?)` are pure and unit-tested field by field:

```ts
{
  Image: image.ref, Hostname: 'sandbox', User: '10001:10001', WorkingDir: '/work',
  Cmd: ['python3', '/opt/parallax/harness/run.py'], Env: ['PARALLAX_JOB=1'],
  Labels: { 'parallax.runner': '1', 'parallax.job': job.jobId },
  AttachStdin: true, OpenStdin: true, StdinOnce: true, AttachStdout: true, AttachStderr: true, Tty: false,
  HostConfig: {
    NetworkMode: 'none', ReadonlyRootfs: true,
    Tmpfs: { '/work': 'rw,noexec,nosuid,nodev,size=64m', '/tmp': 'rw,noexec,nosuid,nodev,size=64m' },
    Memory: memoryMiB << 20, MemorySwap: memoryMiB << 20, PidsLimit: 64, NanoCpus: 1e9,
    CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], Init: true, IpcMode: 'private',
    Ulimits: [{ Name: 'core', Soft: 0, Hard: 0 }, { Name: 'nofile', Soft: 256, Hard: 256 },
              { Name: 'fsize', Soft: 33554432, Hard: 33554432 }],
    LogConfig: { Type: 'none' }, AutoRemove: false, Binds: undefined, Mounts: undefined,
    Runtime: process.env.RUNNER_DOCKER_RUNTIME,   // 'runsc' in production
  },
}
```

Seccomp is Docker's default profile. The job reaches the container only through the attached stdin: after `start()` the runner writes `<nonce>\n` followed by the job JSON (the same document it validated, at most 4 MiB) and ends the stream, which `StdinOnce` closes. Nothing is copied into the container (Docker refuses `putArchive` into a read-only root filesystem) and nothing is mounted from the host; the image's filesystem is the only one the sandbox has, read-only, plus the two tmpfs mounts.

### 7.4 Classification

`classify(container, frame)` is pure:

| Observation | Job status |
| --- | --- |
| `State.OOMKilled` | `resource_exhausted` (result ignored if present) |
| kill timer fired | `time_limited` |
| exit code ≠ 0, or no frame, or frame fails `RunnerResult` | infrastructure failure `harness_failed` / `result_missing` / `result_invalid` (§3.3) |
| result with any check `error`/`memory` | `resource_exhausted` |
| result with any check `timeout` | `time_limited` |
| result with `compileError` or any check `failed`/`error`/`skipped` | `failed` |
| every check `passed` | `passed` |

Precedence is top to bottom. The stdout stream is read with a cap of `2 × outputBytes + 64 KiB`; exceeding it is `result_invalid`.

### 7.5 Reporting, retries and dead letters

A slot that obtains an outcome first sends it as an `execution.result` message (`singletonKey: jobId`, so a duplicate from a retried attempt is dropped by pg-boss while the first is still queued, and by the server's unique `job_id` afterwards), then completes the `execution.run` job with the outcome as output. A transient infrastructure error throws; pg-boss retries (3 attempts, 5 s backoff) and a `GET` of the run shows it `queued` again with `infrastructureAttempts` incremented. A terminal one returns `deadletter`. Both end on the queue `execution.failed` (configured as `execution.run`'s `deadLetter`) with `{ kind, message }` as data, which the server consumes (§8.5). Student outcomes are never retried: a `failed` program is a completed job. A runner that dies mid-container leaves an `active` pg-boss job that the server's supervision of `pgboss_exec` expires at `wallSeconds + 60 s`, which counts as one infrastructure attempt.

### 7.6 Logging

Structured logs carry `jobId`, `runtimeId`, `imageId`, `status`, `durationMs`, `retryCount` and infrastructure error kinds. They never carry file contents, check definitions, captured output, `expected`/`actual` or the nonce; `log.test.ts` serialises a job and an outcome through the logger's redaction and asserts none of those strings appear.

## 8. Server side (`apps/server`)

### 8.1 Code question definition

Part of the test resource revision content (P3-15 defines the test; P3-18 edits it). The fields the runner path depends on, `codeTask.v1`:

```ts
{ kind: 'code', id: string, runtime: RuntimeId, prompt: …,
  files: [{ path, content, encoding?, editable: boolean, hidden: boolean }],   // editable files are the student's; hidden ones never leave a full run
  allowedPackages: string[],            // shown; validated against RUNNER_RUNTIMES[runtime].packages at publication
  limits?: { wallSeconds?, memoryMiB?, outputBytes? },      // clamped to RUNNER_BOUNDS at publication and at enqueue
  checks: [Check & { points: number }] }                     // Check as in job.schema.json; points are for grading, never sent
```

Publication validation (P3-18) rejects: an unknown runtime, a package outside the runtime, limits outside bounds, duplicate check names, no public check, a check naming a file that is not in `files`, a public check naming a hidden file, a file that is both editable and hidden, and a hidden check whose files do not parse. It also runs the author's hidden checks in the instructor preview context so a broken hidden test is found before students meet it.

### 8.2 `buildRunnerJob` and hashes

`buildRunnerJob(question, snapshot, set, jobId, replayImage?)` is pure and tested: it overlays `snapshot.files` (only paths marked `editable` are accepted; others are rejected with 400) on the question's files, keeps the checks whose `visibility` the `set` allows (`public` → public only; `full` → all) and strips `points`, drops hidden files from a `public` job, copies `hidden` onto the files of a `full` job, clamps limits, and validates the result with `RunnerJob` and `validateJob` (§3.1). A `public` job therefore contains no hidden check and no hidden file, which `job-builder.test.ts` and `a12-execution-contracts.itest.ts` assert.

- `codeHash = sha256(canonical(snapshot.files))` where canonical is the JSON of `[{ path, content, encoding }]` sorted by path. It names the student's work only; the UI compares it with the editor's content for the stale label (A12).
- `graderVersion = sha256(canonical({ protocol: 1, runtimeId, image: digest ?? imageId, harnessVersion, checks: question.checks, files: non-editable files, limits })).slice(0, 16)`. It changes when any grading input changes and is stored on every job and result.

### 8.3 Tables (migration in P3-16's chain slot)

`execution_jobs` — one row per run request; class-scoped (`class_id NOT NULL`, registered in `db/scoped.ts`).

| Column | Notes |
| --- | --- |
| `id` uuid pk | the `jobId` sent to the runner |
| `class_id`, `user_id`, `attempt_id` (nullable), `question_revision_id` → `resource_revisions`, `question_id` text | preview runs have `attempt_id NULL` and the preview principal as `user_id` (P1-15) |
| `context` `attempt` \| `preview`; `check_set` `public` \| `full`; `reason` `sample` \| `grading` \| `replay` \| `regrade` \| `preview` | |
| `code_hash`, `snapshot` jsonb (the editable files, ≤ 2 MiB) | the snapshot is kept so a replay runs the same bytes even if the submission tables change shape |
| `runtime_id`, `image_ref`, `harness_version`, `grader_version`, `limits` jsonb | what was sent |
| `boss_job_id` uuid unique, `state`, `infrastructure_attempts` int, `priority` int | `state` ∈ `queued`, `running`, `passed`, `failed`, `time_limited`, `resource_exhausted`, `cancelled`, `infrastructure_error`; `running` is observed from pg-boss at read time and persisted when the result arrives |
| `requested_by` → users, `note` text, `superseded_by` → execution_jobs, `reused_result_id` → execution_results (nullable) | instructor replays carry the actor and reason; a reused run points at the result it reused |
| `queued_at`, `started_at`, `finished_at` | |

`execution_results` — immutable; one per job (`job_id` unique); class-scoped.

| Column | Notes |
| --- | --- |
| `id`, `job_id`, `class_id`, `user_id`, `attempt_id`, `question_revision_id`, `question_id`, `check_set`, `reason`, `code_hash` | denormalised so results can be listed and restored (A22) without joining jobs |
| `status` (the terminal job status), `image_id`, `image_digest` (nullable), `harness_version`, `grader_version` | |
| `outcome` jsonb | the validated `RunnerOutcome`, hidden checks included |
| `created_at` | |

Indexes: `execution_jobs (user_id, state)`, `(attempt_id, question_id, queued_at)`, `(class_id)`; `execution_results (attempt_id, question_id)`, `(attempt_id, question_id, code_hash, check_set, grader_version)` for reuse within one attempt.

The same migration runs `CREATE SCHEMA IF NOT EXISTS pgboss_exec` and the role statements of §10.3, so the grants exist before pg-boss first creates its tables there.

### 8.4 Two pg-boss instances; enqueueing

The application keeps its scoped jobs (P1-07) in schema `pgboss`. Everything the runner touches lives in a second schema, `pgboss_exec`, served by a second `PgBoss` instance on the same pool (`createBoss(pool, { schema: 'pgboss_exec', role })`): queue `execution.run` (`policy: 'standard'`, `retryLimit: 3`, `retryDelay: 5`, `retryBackoff: true`, `expireInSeconds: 120`, `deleteAfterSeconds: 86400`, `deadLetter: 'execution.failed'`), `execution.result` and `execution.failed`. Both API and worker create the three queues at start-up (idempotent); the runner never creates queues because that needs DDL. The runner role's privileges stop at `pgboss_exec` (§10.3), so a compromised runner can neither read the actor-bearing scoped jobs in `pgboss` nor enqueue one.

Only `apps/server` sends `execution.run`, and only from code that holds a resolved `ClassScope` for the attempt's class. The payload is a `RunnerJob`, not a scoped-job payload: the runner cannot re-resolve membership, so authorisation is complete before `bossExec.send` and is repeated on every read (§8.6). The result and failed handlers are likewise plain `bossExec.work(...)` registrations in worker mode, not `defineScopedJob`s: their messages come from the runner and name no actor. `jobs/scoped.test.ts` asserts that no `*.job.ts` module defines `execution.*` jobs, keeping the exception explicit.

Cancellation: `POST …/runs/:runId/cancel` by the run's owner cancels a `queued` job (`bossExec.cancel`) and marks it `cancelled`; a `running` job answers `409 { error: 'running' }` and runs to its bounded end. Submission and expiry of an attempt cancel its queued sample runs.

### 8.5 Result and failure handlers (worker mode)

| Message | Handler |
| --- | --- |
| `execution.result` `RunnerOutcome` | validate; load the `execution_jobs` row by `outcome.jobId` (unknown id → log and complete, nothing else); insert `execution_results` (`job_id` unique: a duplicate is completed without effect); set `state = outcome.status`, `finished_at`, and `started_at`/`infrastructure_attempts` from `bossExec.getJobById('execution.run', boss_job_id)` (`startedOn`, `retryCount`) |
| `execution.failed` `{ kind, message }` with the dead-lettered job's id | set `state = 'infrastructure_error'`, keep `{ kind, message }` on the row for operators, `finished_at`; for a `reason: 'grading'` run move the attempt to NeedsReview (§8.7) |

Read-time state for a non-terminal row: `GET …/runs/:runId` calls `bossExec.getJobById('execution.run', boss_job_id)` and reports `queued` for `created`/`retry` (with `queuePosition`, §5, from one count query on `pgboss_exec.job`) and `running` for `active`; a missing pg-boss job for a non-terminal row older than its `expireInSeconds` is reported and persisted as `infrastructure_error` with kind `lost`. No server process polls or joins pg-boss tables; the server's only SQL against `pgboss_exec` is that count.

### 8.6 Contracts

All under `/api/classes/:classId/attempts/:attemptId/…` with class scope; students only for attempts they own, instructors for the class. Responses include a `queuePosition` while queued.

| Route | Scope | Behaviour |
| --- | --- | --- |
| `POST …/questions/:questionId/runs` `{ files }` | student (own attempt, attempt `in_progress`) | §2 steps 2–4: `200` reused run of this attempt, `202` queued, `429` cap, `400` non-editable path or oversize |
| `GET …/runs/:runId` | student owner (`reason = 'sample'` runs only, else 404), instructor | student view below; instructors get the full outcome |
| `GET …/questions/:questionId/runs?latest=1` | same | the latest run for the question; for a student the latest `reason = 'sample'` run, so a grading run never reaches `toStudentView` (restores the panel after reload) |
| `POST …/runs/:runId/cancel` | student owner | §8.4 |
| `POST …/questions/:questionId/replays` `{ reason: 'replay' \| 'regrade', note }` | instructor | §9; `202` with the new run id |
| `GET …/results` | instructor | every result of the attempt, hidden checks included |

**Student view.** `toStudentView(job, outcome)` accepts only `check_set = 'public'` jobs (anything else is a programming error that throws) and returns `{ runId, state, codeHash, queuePosition?, queuedAt, startedAt?, finishedAt?, result?: { status, runtime, compileError?, checks: PublicCheck[], truncated, durationMs } }` where `PublicCheck` is the check result **without** any `visibility` field. Because a public job carries no hidden check and no hidden file, nothing a public check prints can contain hidden material. Grading results reach students only through released grades (P4-01, P4-04). The zod response schema is `.strict()`, and `a12-execution-contracts.itest.ts` asserts structurally that no key in the student response schema (recursively) matches `/hidden|visibility|points/i`, that a job built with `set: 'public'` contains no hidden check and no hidden file, that the student routes return 404 for a `full` run of the student's own attempt and never select one for `?latest=1`, and that a stored `full` outcome rendered for an instructor still shows hidden checks.

### 8.7 Grading runs

On submission (P3-15's `submitAttempt`), P3-16 enqueues one `full` run per code question with `reason: 'grading'`, priority 5, against the attempt's pinned question revision. Its result is the automated component the grading item (P4-01) reads: points of passed checks over points of all checks, per question. An `infrastructure_error` on a grading run after retries moves the attempt to NeedsReview with the failure visible to the instructor, who can trigger a replay; the student's attempt is not consumed and their view shows nothing about it (A18).

## 9. Replay and regrade

| | Replay | Regrade |
| --- | --- | --- |
| Purpose | run the identical grading again (lost result, infrastructure failure, audit) | grade with a changed runner image or harness |
| Image | pinned: `runtime.image` = the original result's `image_digest`, or its `image_id` where no digest exists (dev, CI); the runner must still allowlist it (§6.4), otherwise `image_unavailable`/`image_not_allowed` and the instructor is told to regrade instead | current image for the runtime |
| Checks, limits, code | the attempt's pinned question revision and the job's stored `snapshot`, unchanged | same |
| `graderVersion` | identical to the original | recomputed |
| Record | new `execution_jobs` and `execution_results` rows, `reason: 'replay'`, `requested_by`, `note`; the original rows are never updated or deleted | same with `reason: 'regrade'`; the note is required |

A question's checks cannot change under an attempt because the attempt pins its revision (ADR-0003, A16); changing checks means a new revision, a new release and new attempts. Grade overrides (P4-01) reference a result row and keep it, so a regrade never hides the result a grade was based on. `a18-run-unavailable.itest.ts` exercises a replay in CI against the `:dev` image by its id.

## 10. Production placement and network policy

### 10.1 Hosts

| Host | Runs | Reaches | Holds |
| --- | --- | --- | --- |
| API host | `apps/server` api, worker, relay containers | Postgres as the application role; object storage; mail | `SESSION_SECRET`, content token secret, storage credentials; **no Docker socket** |
| Runner host (dedicated VM) | one `apps/runner` process; Docker daemon with gVisor (`runsc`) as the configured runtime | Postgres as `parallax_runner`, nothing else at run time | `RUNNER_DATABASE_URL`, images pulled at deploy time; no application secrets |
| Postgres | | | `pg_hba.conf` admits `parallax_runner` only from the runner host's address and only to the application database |

The runner process is trusted code and runs directly on the runner host (systemd unit, Node 22, the repository's `apps/runner`), or as the `infra/docker/runner.Dockerfile` container with the daemon socket mounted. The socket grants root-equivalent control of that host, which is acceptable only because the host runs nothing else; `infra/compose.prod.yml` (P4-12) places `runner` on a network that contains only Postgres. An escape from a sandbox reaches, at most, the runner host and the `pgboss_exec` schema (§1): student code and outcomes, no identities, no application tables, no scoped jobs.

### 10.2 Flows

| From → to | Allowed | How enforced |
| --- | --- | --- |
| runner host → Postgres 5432 | yes | host firewall egress allowlist; `pg_hba` |
| runner host → image registry | at deploy only | `RUNNER_PULL=never`; registry not in the run-time egress allowlist |
| runner host → anything else | no | egress allowlist |
| anything → runner host | administrative SSH only | ingress rules |
| sandbox container → network | none | `NetworkMode: 'none'`: no interface but loopback, no DNS (asserted by the A13 probes) |
| sandbox → host filesystem, devices, Docker socket | none | no binds or mounts, `CapDrop ALL`, read-only root, gVisor |
| API host → Docker | none | no daemon, no socket |

### 10.3 Database role

`scripts/runner-role.sql` (P3-13), adopted by P3-16's migration with `:app_role` substituted by the role that runs pg-boss (the migration reads it from `DATABASE_URL`; the script takes it as a `psql` variable):

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'parallax_runner') THEN
    CREATE ROLE parallax_runner NOLOGIN;
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS pgboss_exec;
GRANT USAGE ON SCHEMA pgboss_exec TO parallax_runner;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss_exec TO parallax_runner;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA pgboss_exec TO parallax_runner;
ALTER DEFAULT PRIVILEGES FOR ROLE :app_role IN SCHEMA pgboss_exec
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO parallax_runner;
ALTER DEFAULT PRIVILEGES FOR ROLE :app_role IN SCHEMA pgboss_exec GRANT USAGE ON SEQUENCES TO parallax_runner;
ALTER ROLE parallax_runner SET statement_timeout = '30s';
```

No statement touches `public` or `pgboss`: the role never receives a grant there, and the application's tables carry no `PUBLIC` grants, so `USAGE` on `public` through `PUBLIC` reaches nothing (asserted by the test below rather than by a `REVOKE` that would not take effect). The default-privilege statements name the application role explicitly because the queue partitions are created later by pg-boss running as that role, which may differ from the role that runs migrations. Operators give the role a password and `LOGIN` out of band (`ALTER ROLE parallax_runner LOGIN PASSWORD …`, `CONNECTION LIMIT` = slots × processes + 4). pg-boss's worker path needs exactly these rights: `fetch` and `complete` update `pgboss_exec.job`, `send` inserts into it, `fail` deletes and re-inserts the row, `start()` with `migrate: false` reads `pgboss_exec.version` and `pgboss_exec.queue`.

`a13-runner-role.itest.ts` (P3-13) applies the script in its own `beforeAll` against its cloned test database with `:app_role` = the connection's role, grants itself membership (`GRANT parallax_runner TO current_user`, allowed because the creating role holds `ADMIN OPTION`), `SET ROLE parallax_runner`, and asserts: `SELECT` on `users` and `resource_revisions` is denied; `SELECT` and `INSERT` on `pgboss.job` are denied; `SELECT` on `pgboss_exec.version` succeeds. P3-16 extends it with `execution_results` once that table exists.

### 10.4 Deploy and operate

Deploy builds the images, pushes them by digest, updates `RUNNER_RUNTIMES` and `RUNNER_IMAGES` together (keeping the previous digest in `RUNNER_IMAGES` for replays), pulls on the runner host, and restarts the runner. A smoke job runs `job-sample-python.json` through the real path after each deploy. Metrics worth exporting: queue depth and oldest `created` job age on `execution.run`, outcomes per status, `execution.failed` kinds, container duration percentiles.

## 11. Threat model and controls

| Threat | Control | Asserted by |
| --- | --- | --- |
| student code reaches platform credentials or data | no network, no secrets in the container, runner role limited to `pgboss_exec`, payload without identities | `A13 environment holds no secrets`, `A13 network connect and DNS fail without a route`, `A13 runner role cannot read application tables or the application job queue` |
| escape via kernel or daemon | `CapDrop ALL`, `no-new-privileges`, read-only root, no mounts, non-root uid, default seccomp, gVisor in production | policy unit tests; `A13 host files are unreadable and the root filesystem is read-only` |
| resource exhaustion | memory and swap limit, pids limit, 1 CPU, tmpfs sizes, `RLIMIT_FSIZE`, wall budget and kill timer, output caps | `A13 infinite loop ends time_limited within the budget`, `A13 one gibibyte allocation ends resource_exhausted`, `A13 fork bomb hits the pids limit and ends failed`, `A13 ten mebibyte print is truncated at one mebibyte` |
| forged or corrupted result | nonce from stdin, non-dumpable harness, exit-code check, single frame, zod validation, size cap, leftover processes killed before the frame | `A13 result forged on container stdout is ignored`, `frame.test.ts`, `A13 killed harness ends run unavailable, not passed` |
| hidden checks or hidden files reach the student | `set: 'public'` jobs contain no hidden check and no hidden file; the job lives only in the harness's memory; public checks never see a hidden file on disk; student routes serve only `reason = 'sample'` runs; strict response schemas | `a12-execution-contracts.itest.ts` structural tests; `job-builder.test.ts`; harness test `public check sees no hidden file` |
| hidden `call`/`stdio` expectations used as an oracle by the code under test | `expected` and `compare` never leave the harness process; the driver receives only the call | harness test `driver stdin carries no expected value` |
| hidden `script` test read by the solution it imports | residual, inherent to running the test in the student's process: the script is materialised for its own check only, and its stdout is hidden from students; publication preview and instructor review are the controls | documented here |
| a compromised runner role acts as a user | the role has no privilege in `pgboss` (where scoped jobs carry `actorId`) or on application tables; results only create result rows | `A13 runner role cannot read application tables or the application job queue` |
| denial of service by one student | per-student cap, supersede rule, priorities, bounded wall time | `a13-run-cap.itest.ts` |
| student cheats a `call` check by faking its outcome file | out of scope for the sandbox: equivalent to returning the right value; hidden `script` checks and instructor review | documented in §4.5 |
| harness sabotaged (killed) by student code | run ends `harness_failed` → Run unavailable after retries, never `passed`; bounded by three attempts | `A13 killed harness ends run unavailable, not passed` |

## 12. Tests by item

**P3-14 Harness and Python image** (`runner/harness/test_run.py`, stdlib `unittest`, run with the repository's `python3` in the `check` job and inside the built image in the `runner` job): nonce and job read from stdin, missing nonce → exit 64, oversize stream → exit 64, each semantic rule of §3.1 → exit 64 (fixtures under `examples/rejected/`); compile error → `compileError` and all checks `skipped`; `stdio` with each compare mode; `stdio` wrong exit code → `error`/`exit`; `call` value, `raises` matched by base class and message, unexpected exception → `error`/`exception`, expected exception not raised → `failed`; `script` pass and fail; per-check timeout and later checks `skipped`; output cut at `outputBytes` across checks (a single check may use all of it); environment of a child contains exactly the §4.3 keys; `public check sees no hidden file` and `hidden check sees only its declared hidden files`; the check directory is removed after each check; `driver stdin carries no expected value`; leftover processes are killed before the frame; frame has the nonce and nothing else on stdout; every produced result is accepted by a copy of `result.schema.json`'s constraints encoded in the test (field names, enums, lengths). Image test (in the `runner` CI job): `docker run --rm --network none <image> python3 -m unittest discover -s /opt/parallax/harness`, `id -u` is 10001, no setuid binaries, labels present.

**P3-13 Runner worker** (`apps/runner`): `policy.test.ts` (every field of §7.3, including that `Runtime` is set only from config and that limits above bounds are clamped), `payload.test.ts` (stdin stream is nonce, newline, the validated job JSON, at most 4 MiB), `frame.test.ts` (one frame accepted; injected bytes before, between and after ignored; wrong nonce, two frames, oversize rejected), `classify.test.ts` (the §7.4 table), `images.test.ts` (allowlist resolution and matching by reference, id and digest), `config.test.ts` (exact key set), `log.test.ts` (§7.6); `apps/runner/test/worker.itest.ts` with a fake executor (an outcome is sent as `execution.result` and stored as the job output; transient error retried; terminal error dead-lettered to `execution.failed`; a job whose payload fails `RunnerJob` or `validateJob` is dead-lettered); `apps/runner/test/a13-runner-role.itest.ts` (§10.3); `apps/runner/test/a13-sandbox.docker.itest.ts` with the eight A13 probes named in §11 plus `A13 killed harness ends run unavailable, not passed`, run against the image built in the `runner` CI job, skipped without a daemon. `packages/contracts/src/runner.test.ts` parses every example and rejects every file under `examples/invalid/` and `examples/rejected/`, each for its named rule.

**P3-16 Execution records and Run sample tests** (`apps/server`): `job-builder.test.ts` (overlay, editable-only, `public` set strips hidden checks, hidden files and points, clamping, hashes stable under key order); `a12-execution-contracts.itest.ts` (A12: result names the code hash; a second run with identical files in the same attempt is reused and a run with the same files in another attempt is not; the structural and routing assertions of §8.6); `a18-run-unavailable.itest.ts` (A18: a dead-lettered pg-boss job shows `infrastructure_error`, `POST` again creates a new job rather than reusing, the attempt's state and attempt count are unchanged; a grading run failure moves the attempt to NeedsReview; an instructor replay runs against the `:dev` image id); `a13-run-cap.itest.ts` (two runs accepted, third `429` with the queue message, cap ignores grading runs, a new run for the same question supersedes the queued one); `results.itest.ts` (a fake runner sends `execution.result` and dead-letters jobs; every row of the §8.5 table; duplicate result ignored; read-time `queued`/`running`/`lost`).

**P4-11 R runner image**: harness tests for the R branch (skipped where `Rscript` is absent, run inside the R image in CI); `apps/runner/test/a13-sandbox-r.docker.itest.ts` (loop, network, truncation, `call` value and `raises` through `driver.R`).

## 13. Decisions and deviations from ADR-0004

1. **Job over stdin, result over stdout.** ADR-0004 uploaded the bundle with `putArchive` and read `/work/result.json` with `getArchive`. Neither works under its own policy: Docker refuses to copy files into a container whose root filesystem is read-only, a tmpfs is not mounted until start, and nothing on a tmpfs survives exit. The job (files inline, ≤ 4 MiB) therefore follows the nonce on the attached stdin and is held only in the harness's memory, and the harness prints one nonce-framed result document to stdout (§4.2, §4.4, §7.3). Everything in the ADR's policy table is kept, `Init: true` included; the nonce protects the stdout channel that `docker-init`'s inherited descriptors would otherwise expose to same-uid processes. ADR-0004 carries a one-line pointer to this document.
2. **Harness baked into the image, one harness for both languages.** The ADR uploaded the harness with the bundle and foresaw a harness per language. Baking it in binds harness and image into one digest; a Python harness with an R driver removes an R-side JSON and process-control implementation.
3. **Three check kinds.** `script` is added to the ADR's `stdio` and `call` so authors can write hidden tests that need more than one comparison without a test framework in the image.
4. **Separate pg-boss schema and result queues.** The runner's role is confined to `pgboss_exec`, a second pg-boss schema that holds only `execution.run`, `execution.result` and the dead-letter queue `execution.failed`, so it can neither read nor enqueue the actor-bearing scoped jobs of P1-07 in `pgboss`. Outcomes travel back as `execution.result` messages consumed by the server worker through pg-boss's own work loop; infrastructure failures arrive as dead letters. The server never polls or joins pg-boss tables; `queued`/`running` are read-time lookups. The trade-off accepted is a second `PgBoss` instance on the server and one more schema in the migration.
5. **Check `skipped` status, `errorKind`, `compileError`.** Added so compile errors, runtime errors, timeouts and memory kills are distinguishable as spec §11 requires.
6. **Order of items and test layout.** P3-14 (harness and image) precedes P3-13 (worker) so the A13 probes run against the real harness in CI; the `runner` CI job is created by P3-14 and extended by P3-13. The Docker suites live in their own vitest project `runner` rather than inside `integration` as ADR-0006's table has it, so the `integration` job never waits for an image build; P3-13 adds the one-line amendment to ADR-0006 when it creates the project.
7. **Sample-run reuse within an attempt.** Identical (attempt, question, code hash, grader version) public runs return the existing run of that attempt; runs are never shared across attempts or students, and a replay always runs.
8. **Priorities and cap scope.** The cap of two applies to sample runs only; grading runs are system work at lower priority than interactive runs.
9. **File visibility.** Question files carry `hidden`; a `public` job contains no hidden file, a public check never sees one on disk, and a hidden check sees only the hidden files it declares. The driver never receives `expected`, so a `full` run's hidden expectations exist only in the harness's memory.

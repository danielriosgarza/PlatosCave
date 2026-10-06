import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { RunnerCheck, RunnerJob, RunnerOutcome } from '@parallax/contracts';
import Docker from 'dockerode';
import { afterAll, describe, expect, onTestFailed, test } from 'vitest';
import { DockerExecutor, imageDaemon } from '../src/executor';
import { RunnerFailure } from '../src/failure';
import { ImageAllowlist } from '../src/images';
import { JOB_LABEL, SANDBOX_LABEL } from '../src/policy';
import { parseJob, runJob } from '../src/worker';

/**
 * The A13 probes of docs/design/runner.md §11 and §12 for the R runtime, run through the real
 * executor against the image the `runner` CI job builds (`scripts/runner-image.sh build r`).
 * Skipped without a Docker daemon or the image; mandatory in CI.
 */
const IMAGE = process.env.IMAGE_R ?? 'parallax-runner-r:dev';
const docker = new Docker();
const daemon = await docker.ping().then(
  () => true,
  () => false,
);
const imagePresent =
  daemon &&
  (await docker
    .getImage(IMAGE)
    .inspect()
    .then(
      () => true,
      () => false,
    ));

// A secret in the runner's own environment must never reach a sandbox.
const SECRET = `PARALLAX_TEST_SECRET_${randomUUID()}`;
process.env.RUNNER_DATABASE_URL = `postgres://parallax_runner:${SECRET}@db/parallax`;

const executor = new DockerExecutor(docker);
const images = new ImageAllowlist({ 'r-4.6': [IMAGE] }, imageDaemon(docker), 'never');

/** What a failing probe prints: statuses, kinds, messages and stream tails, never whole streams. */
function summary(outcome: RunnerOutcome): string {
  const tail = (text: string) => text.slice(-600);
  return JSON.stringify(
    {
      status: outcome.status,
      container: outcome.container,
      compileError: outcome.result?.compileError,
      checks: outcome.result?.checks.map((c) => ({
        name: c.name,
        status: c.status,
        errorKind: c.errorKind,
        exitCode: c.exitCode,
        signal: c.signal,
        message: c.message,
        stdout: tail(c.stdout),
        stderr: tail(c.stderr),
      })),
      harnessLog: tail(outcome.harnessLog),
    },
    null,
    2,
  );
}

async function run(job: RunnerJob): Promise<RunnerOutcome> {
  const outcome = await runJob(parseJob(job), { executor, images });
  onTestFailed(() => console.error(`outcome of job ${job.jobId}:\n${summary(outcome)}`));
  return outcome;
}

type Check = Partial<RunnerCheck> & { name: string };

/** A job whose files are `{ path: source }` and whose checks default to public `script` checks. */
function job(
  files: Record<string, string>,
  checks: Check[],
  limits: Partial<RunnerJob['limits']> = {},
): RunnerJob {
  return {
    v: 1,
    jobId: randomUUID(),
    runtime: { id: 'r-4.6', language: 'r' },
    set: 'public',
    limits: { wallSeconds: 20, memoryMiB: 512, outputBytes: 1048576, ...limits },
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    checks: checks.map(
      (c) =>
        ({
          kind: 'script',
          visibility: 'public',
          file: Object.keys(files)[0],
          ...c,
        }) as RunnerCheck,
    ),
  };
}

const script = (source: string, limits?: Partial<RunnerJob['limits']>) =>
  job({ 'probe.R': source }, [{ name: 'probe' }], limits);

function checkOf(outcome: RunnerOutcome, index = 0) {
  const check = outcome.result?.checks[index];
  if (!check) throw new Error(`no check ${index} in the result`);
  return check;
}

function expectPassed(outcome: RunnerOutcome) {
  expect(checkOf(outcome).status).toBe('passed');
  expect(outcome.status).toBe('passed');
}

afterAll(async () => {
  if (daemon) await executor.sweep();
});

test.runIf(process.env.CI)('CI provides the R runner image', () => {
  expect(daemon).toBe(true);
  expect(imagePresent).toBe(true);
});

describe.skipIf(!imagePresent)('A13 sandbox probes, R variant (design §11)', () => {
  test('A13 R call check is graded through the driver on the read-only image', async () => {
    const outcome = await run(
      job({ 'solution.R': 'library(jsonlite)\nadd <- function(a, b) a + b\n' }, [
        {
          name: 'add',
          kind: 'call',
          file: 'solution.R',
          function: 'add',
          args: [1, 2],
          expected: { value: 3 },
          compare: { mode: 'exact' },
        },
        {
          name: 'jsonlite',
          kind: 'script',
          file: 'solution.R',
        },
      ]),
    );
    expect(outcome.status).toBe('passed');
    expect(checkOf(outcome, 0).status).toBe('passed');
    expect(outcome.result?.runtime.language).toBe('r');
  });

  test('A13 R environment holds no secrets', async () => {
    const outcome = await run(
      script(`
values <- Sys.getenv()
stopifnot(!any(grepl('${SECRET}', values, fixed = TRUE)))
stopifnot(Sys.getenv('RUNNER_DATABASE_URL') == '')
stopifnot(Sys.getenv('PARALLAX_JOB') == '1')
opened <- tryCatch({ readLines('/proc/1/environ'); TRUE }, error = function(e) FALSE, warning = function(w) FALSE)
stopifnot(!opened)
for (path in c('/var/run/docker.sock', '/run/docker.sock', '/run/secrets')) stopifnot(!file.exists(path))
`),
    );
    expectPassed(outcome);
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  test('A13 R network connect and DNS fail without a route', async () => {
    const outcome = await run(
      script(`
stopifnot(is.null(suppressWarnings(nsl('example.com'))))
for (target in list(c('1.1.1.1', 53), c('8.8.8.8', 443), c('172.17.0.1', 2375))) {
  con <- tryCatch(
    suppressWarnings(socketConnection(target[[1]], as.integer(target[[2]]), open = 'r+', timeout = 3)),
    error = function(e) NULL
  )
  if (!is.null(con)) { close(con); stop('connected to ', target[[1]]) }
}
lines <- readLines('/proc/net/dev')[-(1:2)]
stopifnot(identical(trimws(sub(':.*', '', lines)), 'lo'))
`),
    );
    expectPassed(outcome);
  });

  test('A13 R host files are unreadable and the root filesystem is read-only', async () => {
    const outcome = await run(
      script(`
stopifnot(system('id -u', intern = TRUE) == '10001')
for (path in c('/etc/probe', '/usr/probe', '/opt/parallax/harness/probe')) {
  stopifnot(!suppressWarnings(file.create(path)))
}
read <- tryCatch({ readLines('/etc/shadow'); TRUE }, error = function(e) FALSE, warning = function(w) FALSE)
stopifnot(!read)
stopifnot(!any(grepl('docker.sock', readLines('/proc/mounts'), fixed = TRUE)))
`),
    );
    expectPassed(outcome);
  });

  test('A13 R infinite loop ends time_limited within the budget', async () => {
    const wallSeconds = 3;
    const outcome = await run(
      job(
        { 'loop.R': 'repeat {}\n' },
        [
          {
            name: 'loop',
            kind: 'stdio',
            expected: { stdout: 'never' },
            compare: { mode: 'exact' },
          },
        ],
        { wallSeconds },
      ),
    );
    expect(outcome.status).toBe('time_limited');
    expect(checkOf(outcome).status).toBe('timeout');
    expect(outcome.container.killedByTimer).toBe(false);
    expect(outcome.container.durationMs).toBeLessThan((wallSeconds + 5) * 1000);
  });

  test('A13 R one gibibyte allocation ends resource_exhausted', async () => {
    const outcome = await run(script('x <- numeric(2^27)\ncat(length(x))\n', { memoryMiB: 256 }));
    expect(outcome.status).toBe('resource_exhausted');
    if (outcome.result) {
      expect(checkOf(outcome)).toMatchObject({ status: 'error', errorKind: 'memory' });
    } else {
      expect(outcome.container.oomKilled).toBe(true);
    }
  });

  test('A13 R fork bomb hits the pids limit and ends failed', async () => {
    const outcome = await run(
      job(
        {
          // Small processes from one shell: forked R interpreters would meet the memory limit first.
          // The shell stops with a failure status once fork is refused; the script fails with it.
          'bomb.R': "stopifnot(system('while :; do sleep 100 & done') == 0)\n",
          'after.R': "cat('still running')\n",
        },
        [
          { name: 'bomb', file: 'bomb.R', timeoutSeconds: 10 },
          {
            name: 'after the bomb',
            kind: 'stdio',
            file: 'after.R',
            expected: { stdout: 'still running' },
            compare: { mode: 'trimmed' },
          },
        ],
        { wallSeconds: 30, memoryMiB: 2048 },
      ),
    );
    expect(outcome.status).toBe('failed');
    // The shell loop never ends by itself: the per-check timeout stops it.
    expect(['failed', 'error', 'timeout']).toContain(checkOf(outcome, 0).status);
    expect(checkOf(outcome, 1).status).toBe('passed');
  });

  test('A13 R ten mebibyte print is truncated at one mebibyte', async () => {
    const outcome = await run(
      job({ 'print.R': "cat(strrep('x', 10 * 1024 * 1024))\n" }, [
        { name: 'print', kind: 'stdio', expected: { stdout: 'x' }, compare: { mode: 'exact' } },
      ]),
    );
    expect(outcome.status).toBe('failed');
    const check = checkOf(outcome);
    expect(check.truncated).toBe(true);
    expect(outcome.result?.truncated).toBe(true);
    expect(Buffer.byteLength(check.stdout)).toBeLessThanOrEqual(1048576);
    expect(Buffer.byteLength(check.stdout)).toBeGreaterThan(1048576 - 4096);
  });

  test("A13 R writing to the container's stdout through pid 1 is refused and the result is still read", async () => {
    const outcome = await run(
      script(`
cat('PROBE-TEXT-OWN-STDERR\\n', file = stderr())
for (fd in 1:2) {
  opened <- tryCatch({
    con <- file(sprintf('/proc/1/fd/%d', fd), 'w')
    writeLines(rep('PROBE-TEXT-THROUGH-PID-1', 100000), con)
    close(con)
    TRUE
  }, error = function(e) FALSE, warning = function(w) FALSE)
  stopifnot(!opened)
}
cat('refused\\n')
`),
    );
    expectPassed(outcome);
    expect(outcome.harnessLog).not.toContain('PROBE-TEXT');
  });

  test('A13 R signals from student code to pid 1 are discarded', async () => {
    const outcome = await run(
      script(`
for (signal in c(tools::SIGKILL, tools::SIGTERM, tools::SIGINT)) tools::pskill(1L, signal)
Sys.sleep(0.5)
cat('harness still alive\\n')
`),
    );
    expectPassed(outcome);
    expect(outcome.container.exitCode).toBe(0);
  });

  test('A13 R killed harness ends run unavailable, not passed', async () => {
    const sleeper = script('Sys.sleep(50)\n', { wallSeconds: 60 });
    const pending = run(sleeper).then(
      (outcome) => outcome,
      (error: unknown) => error,
    );
    const id = await (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const [found] = await docker.listContainers({
          filters: { label: [`${SANDBOX_LABEL}=1`, `${JOB_LABEL}=${sleeper.jobId}`] },
        });
        if (found?.State === 'running') return found.Id;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error('the sandbox never started');
    })();
    // Give the harness time to start the check, then kill it from the host.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await promisify(execFile)('docker', ['kill', '-s', 'KILL', id]);

    const settled = await pending;
    expect(settled).toBeInstanceOf(RunnerFailure);
    const failure = settled as RunnerFailure;
    expect(failure.kind).toBe('harness_failed');
    expect(failure.terminal).toBe(false);
  });
});

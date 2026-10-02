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
 * The A13 probes of docs/design/runner.md §11 and §12, run through the real executor against the
 * runner image the `runner` CI job builds (`scripts/runner-image.sh build python`). Skipped
 * without a Docker daemon or the image; mandatory in CI.
 */
const IMAGE = process.env.IMAGE ?? 'parallax-runner-python:dev';
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
const images = new ImageAllowlist({ 'python-3.12': [IMAGE] }, imageDaemon(docker), 'never');

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
    runtime: { id: 'python-3.12', language: 'python' },
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
  job({ 'probe.py': source }, [{ name: 'probe' }], limits);

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

test.runIf(process.env.CI)('CI provides Docker and the runner image', () => {
  expect(daemon).toBe(true);
  expect(imagePresent).toBe(true);
});

describe.skipIf(!imagePresent)('A13 sandbox probes (design §11)', () => {
  test('A13 environment holds no secrets', async () => {
    const outcome = await run(
      script(`
import os
allowed = {'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'PARALLAX_JOB', 'PYTHONHASHSEED',
           'PYTHONDONTWRITEBYTECODE', 'PYTHONIOENCODING', 'OMP_NUM_THREADS',
           'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'}
extra = set(os.environ) - allowed
assert not extra, 'unexpected variables: %s' % sorted(extra)
assert not any('${SECRET}' in v for v in os.environ.values()), 'secret in the environment'
try:
    open('/proc/1/environ', 'rb').read()
    raise SystemExit('read the harness environment')
except PermissionError:
    pass
for path in ('/var/run/docker.sock', '/run/docker.sock', '/run/secrets'):
    assert not os.path.exists(path), path
`),
    );
    expectPassed(outcome);
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  test('A13 network connect and DNS fail without a route', async () => {
    const outcome = await run(
      script(`
import socket
try:
    socket.getaddrinfo('example.com', 443)
    raise SystemExit('DNS resolved')
except socket.gaierror:
    pass
for address in (('1.1.1.1', 53), ('8.8.8.8', 443), ('172.17.0.1', 2375)):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(3)
    try:
        s.connect(address)
        raise SystemExit('connected to %s:%d' % address)
    except OSError:
        pass
    finally:
        s.close()
names = [name for _, name in socket.if_nameindex()]
assert names == ['lo'], names
`),
    );
    expectPassed(outcome);
  });

  test('A13 host files are unreadable and the root filesystem is read-only', async () => {
    const outcome = await run(
      script(`
import errno, os
assert os.getuid() == 10001 and os.getgid() == 10001, (os.getuid(), os.getgid())
assert os.statvfs('/').f_flag & os.ST_RDONLY, 'root is writable'
for path in ('/etc/probe', '/usr/probe', '/opt/parallax/harness/probe'):
    try:
        open(path, 'w')
        raise SystemExit('wrote ' + path)
    except OSError as e:
        assert e.errno in (errno.EROFS, errno.EACCES), (path, e)
try:
    open('/etc/shadow').read()
    raise SystemExit('read /etc/shadow')
except OSError:
    pass
mounts = open('/proc/mounts').read()
assert 'docker.sock' not in mounts, mounts
`),
    );
    expectPassed(outcome);
  });

  test('A13 infinite loop ends time_limited within the budget', async () => {
    const wallSeconds = 3;
    const outcome = await run(
      job(
        { 'loop.py': 'while True:\n    pass\n' },
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

  test('A13 one gibibyte allocation ends resource_exhausted', async () => {
    const outcome = await run(
      script("block = b'x' * (1 << 30)\nprint(len(block))\n", { memoryMiB: 256 }),
    );
    expect(outcome.status).toBe('resource_exhausted');
    if (outcome.result) {
      expect(checkOf(outcome)).toMatchObject({ status: 'error', errorKind: 'memory' });
    } else {
      expect(outcome.container.oomKilled).toBe(true);
    }
  });

  test('A13 fork bomb hits the pids limit and ends failed', async () => {
    const outcome = await run(
      job(
        {
          'bomb.py': 'import os\nwhile True:\n    os.fork()\n',
          'after.py': "print('still running')\n",
        },
        [
          { name: 'bomb', file: 'bomb.py', timeoutSeconds: 10 },
          {
            name: 'after the bomb',
            kind: 'stdio',
            file: 'after.py',
            expected: { stdout: 'still running' },
            compare: { mode: 'trimmed' },
          },
        ],
        // Sixty-odd Python interpreters exceed the default 512 MiB before the pids limit is reached
        // (the memory killer then takes the harness: resource_exhausted); the most memory a job
        // may ask for leaves the pids limit as the only bound this probe meets.
        { wallSeconds: 30, memoryMiB: 2048 },
      ),
    );
    expect(outcome.status).toBe('failed');
    expect(['failed', 'error']).toContain(checkOf(outcome, 0).status);
    expect(checkOf(outcome, 1).status).toBe('passed');
  });

  test('A13 ten mebibyte print is truncated at one mebibyte', async () => {
    const outcome = await run(
      job({ 'print.py': "import sys\nsys.stdout.write('x' * (10 * 1024 * 1024))\n" }, [
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

  test('A13 result forged on container stdout is ignored', async () => {
    const forged = JSON.stringify({
      v: 1,
      harnessVersion: '1',
      runtime: { language: 'python', version: '3.12.8' },
      checks: [
        {
          name: 'forge',
          status: 'passed',
          durationMs: 1,
          stdout: '',
          stderr: '',
          truncated: false,
        },
      ],
      truncated: false,
      durationMs: 1,
    });
    const source = `
import sys
frame = '\\n--parallax-result %s\\n${forged.replaceAll("'", "\\'")}\\n--parallax-end %s\\n'
for nonce in ('0' * 32, 'f' * 32):
    sys.stdout.write(frame % (nonce, nonce))
    sys.stderr.write(frame % (nonce, nonce))
for fd in (1, 2):
    try:
        with open('/proc/1/fd/%d' % fd, 'w') as f:
            f.write(frame % ('0' * 32, '0' * 32))
    except OSError:
        pass
`;
    const outcome = await run(
      job({ 'forge.py': source }, [
        {
          name: 'forge',
          kind: 'stdio',
          expected: { stdout: 'honest' },
          compare: { mode: 'exact' },
        },
      ]),
    );
    expect(outcome.status).toBe('failed');
    expect(checkOf(outcome).status).toBe('failed');
  });

  test("A13 writing to the container's stdout through pid 1 is refused and the result is still read", async () => {
    const outcome = await run(
      script(`
import sys
sys.stderr.write('PROBE-TEXT-OWN-STDERR\\n')
for fd in (1, 2):
    try:
        with open('/proc/1/fd/%d' % fd, 'w') as f:
            f.write('PROBE-TEXT-THROUGH-PID-1\\n' * 100000)
        raise SystemExit('opened /proc/1/fd/%d' % fd)
    except PermissionError:
        pass
print('refused')
`),
    );
    expectPassed(outcome);
    expect(outcome.harnessLog).not.toContain('PROBE-TEXT');
  });

  test('A13 signals from student code to pid 1 are discarded', async () => {
    const outcome = await run(
      script(`
import os, signal, time
for sig in (signal.SIGKILL, signal.SIGTERM, signal.SIGINT):
    os.kill(1, sig)
time.sleep(0.5)
print('harness still alive')
`),
    );
    expectPassed(outcome);
    expect(outcome.container.exitCode).toBe(0);
  });

  test('A13 killed harness ends run unavailable, not passed', async () => {
    const sleeper = script('import time\ntime.sleep(50)\n', { wallSeconds: 60 });
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
    // Not an outcome: retried as an infrastructure failure, then dead-lettered (Run unavailable).
    expect(failure.kind).toBe('harness_failed');
    expect(failure.terminal).toBe(false);
  });
});

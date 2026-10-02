import { randomUUID } from 'node:crypto';
import { type RunnerJob, RunnerOutcome } from '@parallax/contracts';
import { type JobWithMetadata, PgBoss } from 'pg-boss';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { ContainerRun, Executor } from '../src/executor';
import { RunnerFailure } from '../src/failure';
import { newNonce } from '../src/payload';
import type { ResolvedImage } from '../src/policy';
import { frameBytes } from '../src/test-frames';
import { EXEC_SCHEMA, FAILED_QUEUE, RESULT_QUEUE, RUN_QUEUE, startSlots } from '../src/worker';
import { createTestDatabase, type TestDatabase } from './db';

const image: ResolvedImage = {
  ref: 'parallax-runner-python:dev',
  id: `sha256:${'d'.repeat(64)}`,
  digest: null,
};

type Mode = 'pass' | 'transient-once' | 'transient-always' | 'exit-64';

/** Stands in for Docker: each job id is told how its container behaves. */
class FakeExecutor implements Executor {
  readonly modes = new Map<string, Mode>();
  readonly attempts = new Map<string, number>();

  async run(job: RunnerJob): Promise<ContainerRun> {
    const attempt = (this.attempts.get(job.jobId) ?? 0) + 1;
    this.attempts.set(job.jobId, attempt);
    const mode = this.modes.get(job.jobId) ?? 'pass';
    if (mode === 'transient-always' || (mode === 'transient-once' && attempt === 1)) {
      throw new RunnerFailure('daemon_unreachable', 'docker: connect ENOENT');
    }
    const nonce = newNonce();
    const result = {
      v: 1,
      harnessVersion: '1',
      runtime: { language: 'python', version: '3.12.8' },
      checks: job.checks.map((c) => ({
        name: c.name,
        status: 'passed',
        durationMs: 3,
        stdout: '',
        stderr: '',
        truncated: false,
      })),
      truncated: false,
      durationMs: 9,
    };
    return {
      nonce,
      exitCode: mode === 'exit-64' ? 64 : 0,
      oomKilled: false,
      killedByTimer: false,
      durationMs: 40,
      stdout: mode === 'exit-64' ? Buffer.alloc(0) : frameBytes(nonce, result),
      stdoutOverflow: false,
      stderrTail: '',
    };
  }
}

function job(jobId = randomUUID()): RunnerJob {
  return {
    v: 1,
    jobId,
    runtime: { id: 'python-3.12', language: 'python' },
    set: 'public',
    limits: { wallSeconds: 10, memoryMiB: 512, outputBytes: 1048576 },
    files: [{ path: 'solution.py', content: 'print(1)\n' }],
    checks: [
      {
        name: 'Prints one',
        kind: 'stdio',
        visibility: 'public',
        file: 'solution.py',
        expected: { stdout: '1\n' },
        compare: { mode: 'trimmed' },
      },
    ],
  };
}

let testDb: TestDatabase;
/** The server's instance on pgboss_exec: owns the schema and the queues (P3-16). */
let server: PgBoss;
/** The runner's instance: no migrations, no supervision, no schedules (design §7.2). */
let runner: PgBoss;
const executor = new FakeExecutor();
const deadLetters: JobWithMetadata<unknown>[] = [];

async function waitFor<T>(probe: () => Promise<T | null | undefined>, ms = 12_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const settled = (id: string) =>
  waitFor(async () => {
    const found = await server.getJobById(RUN_QUEUE, id);
    return found && ['completed', 'failed'].includes(found.state) ? found : null;
  });

/** The dead letter pg-boss created for run job `sourceId`, read with its metadata. */
const deadLetterOf = (sourceId: string) =>
  waitFor(async () => {
    deadLetters.push(
      ...(await server.fetch(FAILED_QUEUE, { includeMetadata: true, batchSize: 20 })),
    );
    return deadLetters.find((d) => d.sourceId === sourceId);
  });

beforeAll(async () => {
  testDb = await createTestDatabase();
  server = new PgBoss({ connectionString: testDb.url, max: 3, schema: EXEC_SCHEMA });
  server.on('error', () => undefined);
  await server.start();
  await server.createQueue(FAILED_QUEUE, { deleteAfterSeconds: 3600 });
  await server.createQueue(RESULT_QUEUE, { policy: 'short', deleteAfterSeconds: 3600 });
  await server.createQueue(RUN_QUEUE, {
    deadLetter: FAILED_QUEUE,
    retryLimit: 1,
    retryDelay: 1,
    deleteAfterSeconds: 3600,
  });

  runner = new PgBoss({
    connectionString: testDb.url,
    max: 4,
    schema: EXEC_SCHEMA,
    migrate: false,
    supervise: false,
    schedule: false,
  });
  runner.on('error', () => undefined);
  await runner.start();
  const images = { resolve: async () => image };
  await startSlots({ boss: runner, executor, images, log: pino({ level: 'silent' }) }, 2);
});

afterAll(async () => {
  await runner?.stop({ graceful: false, close: true });
  await server?.stop({ graceful: false, close: true });
  await testDb?.drop();
});

describe('runner worker on pg-boss (design §7.5)', () => {
  test('an outcome is sent as execution.result with id jobId and stored as the job output', async () => {
    const payload = job();
    const id = (await server.send(RUN_QUEUE, payload)) as string;
    const done = await settled(id);
    expect(done.state).toBe('completed');
    const outcome = RunnerOutcome.parse(done.output);
    expect(outcome).toMatchObject({
      jobId: payload.jobId,
      status: 'passed',
      image,
      container: { exitCode: 0, oomKilled: false, killedByTimer: false },
    });
    const message = await server.getJobById(RESULT_QUEUE, payload.jobId);
    expect(message?.data).toEqual(outcome);
  });

  test('a second send for the same jobId is the dropped duplicate and the run job completes', async () => {
    const payload = job();
    const first = { first: true };
    expect(await server.send(RESULT_QUEUE, first, { id: payload.jobId })).toBe(payload.jobId);
    const id = (await server.send(RUN_QUEUE, payload)) as string;
    const done = await settled(id);
    expect(done.state).toBe('completed');
    expect(RunnerOutcome.parse(done.output).jobId).toBe(payload.jobId);
    expect((await server.getJobById(RESULT_QUEUE, payload.jobId))?.data).toEqual(first);
  });

  test('a transient failure is retried', async () => {
    const payload = job();
    executor.modes.set(payload.jobId, 'transient-once');
    const id = (await server.send(RUN_QUEUE, payload)) as string;
    const done = await settled(id);
    expect(done.state).toBe('completed');
    expect(done.retryCount).toBe(1);
    expect(executor.attempts.get(payload.jobId)).toBe(2);
  });

  test('retries spent: the dead letter carries the job document and the failure kind', async () => {
    const payload = job();
    executor.modes.set(payload.jobId, 'transient-always');
    const id = (await server.send(RUN_QUEUE, payload)) as string;
    const dead = await deadLetterOf(id);
    expect(executor.attempts.get(payload.jobId)).toBe(2);
    expect(dead.data).toEqual(payload);
    expect(dead.sourceOutput).toMatchObject({ kind: 'daemon_unreachable' });
  });

  test('a terminal failure is dead-lettered at once with { kind, message }', async () => {
    const payload = job();
    executor.modes.set(payload.jobId, 'exit-64');
    const id = (await server.send(RUN_QUEUE, payload)) as string;
    const dead = await deadLetterOf(id);
    expect(executor.attempts.get(payload.jobId)).toBe(1);
    expect(dead.data).toEqual(payload);
    expect(dead.sourceId).toBe(id);
    expect(dead.sourceOutput).toEqual({
      kind: 'job_invalid',
      message: 'the harness refused the job (exit 64)',
    });
    expect(await server.getJobById(RESULT_QUEUE, payload.jobId)).toBeNull();
  });

  test('a payload failing RunnerJob or validateJob is dead-lettered without a container', async () => {
    const notAJob = { v: 1, jobId: randomUUID(), runtime: { id: 'python-3.12' } };
    const duplicate = job();
    const [first] = duplicate.checks;
    duplicate.checks.push({ ...(first as RunnerJob['checks'][number]) });
    for (const payload of [notAJob, duplicate]) {
      const id = (await server.send(RUN_QUEUE, payload)) as string;
      const dead = await deadLetterOf(id);
      expect(dead.data).toEqual(payload);
      expect(dead.sourceOutput).toMatchObject({ kind: 'job_invalid' });
      expect(executor.attempts.has(payload.jobId)).toBe(false);
    }
  });
});

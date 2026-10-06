import { randomUUID } from 'node:crypto';
import type { RunnerJob, RunnerOutcome } from '@parallax/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { type JobWithMetadata, PgBoss } from 'pg-boss';
import { buildApp } from '../../src/app';
import { DEV_RUNNER_RUNTIMES, loadConfig } from '../../src/config';
import { adoptRelease } from '../../src/db/content/adoption';
import { createResource } from '../../src/db/content/drafts';
import { publishRelease } from '../../src/db/content/releases';
import { onDeadLetter, onResultMessage } from '../../src/db/execution/results';
import { createBoss, EXEC_SCHEMA } from '../../src/db/jobs/boss';
import { classMemberships, executionJobs, executionResults } from '../../src/db/schema';
import {
  ensureExecQueues,
  FAILED_QUEUE,
  RESULT_QUEUE,
  RUN_QUEUE,
} from '../../src/execution/queues';
import { storeCourseObject } from '../../src/storage/objects';
import type { Storage } from '../../src/storage/storage';
import {
  asClassScope,
  asCourseScope,
  buildWorld,
  ids,
  type PersonName,
  type World,
} from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

/**
 * The world of the execution itests (docs/design/runner.md §12, P3-16): the standard world with
 * a test of three code questions adopted by classes A and B, Sam enrolled in both classes (so
 * the cap's cross-class count is observable), the API on a real `pgboss_exec` instance, and a
 * fake runner that drives jobs through pg-boss's own fetch, complete and fail, so every result
 * message and dead letter is produced by pg-boss as in production.
 */

export const start = new Date('2026-10-01T09:00:00Z');

const codeQuestion = (id: string, fn: string, expected: number) => ({
  id,
  kind: 'code',
  prompt: `Write ${fn}(xs).`,
  points: 4,
  runtime: 'python-3.12',
  files: [
    { path: 'solution.py', content: `def ${fn}(xs):\n    pass\n`, editable: true, hidden: false },
    { path: 'large.txt', content: '40 44', editable: false, hidden: true },
  ],
  checks: [
    {
      name: 'sample',
      kind: 'call',
      visibility: 'public',
      file: 'solution.py',
      function: fn,
      args: [[1, 2, 3]],
      expected: { value: expected },
      compare: { mode: 'numeric' },
    },
    {
      name: 'hidden-large',
      kind: 'call',
      visibility: 'hidden',
      file: 'solution.py',
      files: ['large.txt'],
      function: fn,
      args: [[40, 44]],
      expected: { value: 42 },
      compare: { mode: 'numeric' },
      points: 3,
    },
  ],
});

export const quiz = {
  settings: { attempts: 3 },
  questions: [
    codeQuestion('mean', 'mean', 2),
    codeQuestion('median', 'median', 2),
    codeQuestion('spread', 'spread', 2),
    {
      id: 'pick',
      kind: 'choice',
      prompt: 'Which varies least?',
      points: 1,
      options: [
        { id: 'a', label: 'n = 10' },
        { id: 'b', label: 'n = 100' },
      ],
      correct: ['b'],
    },
  ],
};

export const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  APP_HOST: '127.0.0.1',
  CONTENT_HOST: 'localhost',
  CONTENT_ORIGIN: 'http://localhost:3100',
  APP_ORIGIN: 'http://127.0.0.1:3100',
});

export const DEV_IMAGE_ID = `sha256:${'d'.repeat(64)}`;

export interface ExecWorld {
  testDb: TestDatabase;
  world: World;
  app: FastifyInstance;
  /** The server's instance on pgboss_exec. */
  boss: PgBoss;
  runner: FakeRunner;
  quizId: string;
  clock: { now: Date };
  close: () => Promise<void>;
}

export interface ExecWorldOptions {
  /** The API's object store (default: the one the config selects). */
  storage?: Storage;
  /** Files stored in the course and named by the quiz revision's `objectKeys`; needs `storage`. */
  quizObjects?: { bytes: Uint8Array; contentType: string }[];
}

export async function execWorld(options: ExecWorldOptions = {}): Promise<ExecWorld> {
  const { storage, quizObjects = [] } = options;
  if (quizObjects.length > 0 && !storage) throw new Error('quizObjects need a storage');
  const testDb = await createTestDatabase();
  const world = await buildWorld(testDb.db, start);
  const course = asCourseScope(ids.statistics, ids.elena);
  const objectKeys: string[] = [];
  for (const { bytes, contentType } of quizObjects) {
    objectKeys.push(
      (await storeCourseObject(testDb.db, storage as Storage, course, bytes, contentType)).key,
    );
  }
  const created = await createResource(
    testDb.db,
    course,
    ids.sampling,
    { type: 'test', title: 'Spread check', content: quiz, objectKeys },
    start,
  );
  if (!created.ok) throw new Error(JSON.stringify(created));
  const published = await publishRelease(testDb.db, course, { runtimes: DEV_RUNNER_RUNTIMES });
  if (!published.ok) throw new Error(JSON.stringify(published.report));
  for (const [classId, instructor] of [
    [ids.classA, ids.priya],
    [ids.classB, ids.marcus],
  ] as const) {
    const adopted = await adoptRelease(
      testDb.db,
      asClassScope(classId, ids.statistics, instructor, { releaseId: ids.releaseV1 }),
      { releaseId: published.release.id, expectedReleaseId: ids.releaseV1 },
    );
    if (!adopted.ok) throw new Error(adopted.reason);
  }
  await testDb.db
    .insert(classMemberships)
    .values({ classId: ids.classB, userId: ids.sam, role: 'student' });

  const pool = new pg.Pool({ connectionString: testDb.url, max: 4 });
  const boss = createBoss(pool, {
    role: 'api',
    schema: EXEC_SCHEMA,
    onError: () => undefined,
    onWarning: () => undefined,
  });
  await boss.start();
  await ensureExecQueues(boss);
  const runner = new FakeRunner(testDb.url);
  await runner.start();
  const clock = { now: start };
  const app = await buildApp(config, {
    db: testDb.db,
    now: () => clock.now,
    bossExec: boss,
    ...(storage && { storage }),
  });
  await app.ready();
  return {
    testDb,
    world,
    app,
    boss,
    runner,
    quizId: created.value.id,
    clock,
    close: async () => {
      await app.close();
      await runner.stop();
      await boss.stop({ graceful: false, close: false });
      await pool.end();
      await testDb.drop();
    },
  };
}

/** One request as a person, with the response body as JSON. */
export async function call(
  w: ExecWorld,
  who: PersonName,
  method: 'GET' | 'POST',
  url: string,
  payload?: object,
) {
  const res = await w.app.inject({
    method,
    url,
    headers: { host: '127.0.0.1:3100', cookie: w.world.cookie[who] },
    ...(payload && { payload }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: assertions walk the response freely.
  return { status: res.statusCode, body: res.json() as any };
}

export const attemptUrl = (classId: string, attemptId: string) =>
  `/api/classes/${classId}/test-attempts/${attemptId}`;

/** Starts (or resumes) the person's attempt of the quiz in a class. */
export async function startAttempt(w: ExecWorld, who: PersonName, classId: string) {
  const res = await call(
    w,
    who,
    'POST',
    `/api/classes/${classId}/resources/${w.quizId}/test-attempts`,
  );
  if (res.status !== 200) throw new Error(`start: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}

export const files = (content: string) => [{ path: 'solution.py', content }];

export function requestRun(
  w: ExecWorld,
  who: PersonName,
  classId: string,
  attemptId: string,
  questionId: string,
  content: string,
) {
  return call(w, who, 'POST', `${attemptUrl(classId, attemptId)}/questions/${questionId}/runs`, {
    files: files(content),
  });
}

export async function rowOf(w: ExecWorld, runId: string) {
  const [row] = await w.testDb.db.select().from(executionJobs).where(eq(executionJobs.id, runId));
  if (!row) throw new Error(`no run ${runId}`);
  return row;
}

export const resultsOf = (w: ExecWorld, runId: string) =>
  w.testDb.db.select().from(executionResults).where(eq(executionResults.jobId, runId));

/** An outcome for a job: every check passes, or the named checks fail. */
export function outcomeFor(job: RunnerJob, failing: string[] = []): RunnerOutcome {
  const checks = job.checks.map((c) =>
    failing.includes(c.name)
      ? {
          name: c.name,
          status: 'failed' as const,
          durationMs: 4,
          expected: '42',
          actual: 'None',
          message: 'values differ',
          stdout: `secret output of ${c.name}`,
          stderr: '',
          truncated: false,
        }
      : {
          name: c.name,
          status: 'passed' as const,
          durationMs: 3,
          stdout: '',
          stderr: '',
          truncated: false,
        },
  );
  return {
    v: 1,
    jobId: job.jobId,
    status: failing.length > 0 ? 'failed' : 'passed',
    image: { ref: 'parallax-runner-python:dev', id: DEV_IMAGE_ID, digest: null },
    container: { exitCode: 0, oomKilled: false, killedByTimer: false, durationMs: 40 },
    result: {
      v: 1,
      harnessVersion: '1',
      runtime: { language: 'python', version: '3.12.8' },
      checks,
      truncated: false,
      durationMs: 9,
    },
    harnessLog: '',
  };
}

/**
 * Stands in for `apps/runner` with the runner's own pg-boss settings (no migrations, no
 * supervision). Each step is a pg-boss call: `take` fetches the next job, `finish` sends the
 * result message with `id: jobId` and completes the job with the outcome, `fail` fails it and
 * `failUntilDeadLetter` fails every attempt (refetching past the backoff) until pg-boss
 * dead-letters it onto `execution.failed`.
 */
export class FakeRunner {
  readonly boss: PgBoss;

  constructor(url: string) {
    this.boss = new PgBoss({
      connectionString: url,
      max: 3,
      schema: EXEC_SCHEMA,
      migrate: false,
      supervise: false,
      schedule: false,
    });
    this.boss.on('error', () => undefined);
  }

  start = () => this.boss.start().then(() => undefined);
  stop = () => this.boss.stop({ graceful: false, close: true });

  /** Fetches the next job of `execution.run`, as a slot does; fails when there is none. */
  async take(): Promise<JobWithMetadata<RunnerJob>> {
    const [job] = await this.boss.fetch<RunnerJob>(RUN_QUEUE, {
      includeMetadata: true,
      ignoreStartAfter: true,
    });
    if (!job) throw new Error('no run job to take');
    return job;
  }

  /** The runner's success path (design §7.5): the result message, then the completed job. */
  async finish(job: JobWithMetadata<RunnerJob>, outcome = outcomeFor(job.data)) {
    await this.boss.send(RESULT_QUEUE, outcome, { id: outcome.jobId, singletonKey: outcome.jobId });
    await this.boss.complete(RUN_QUEUE, job.id, outcome);
    return outcome;
  }

  /** Fails the fetched attempt with the runner's `{ kind, message }`. */
  fail(job: { id: string }, output: object) {
    return this.boss.fail(RUN_QUEUE, job.id, output);
  }

  /** Fails every attempt of the next job until pg-boss dead-letters it; returns its id. */
  async failUntilDeadLetter(
    output: object = { kind: 'daemon_unreachable', message: 'docker down' },
  ) {
    let job = await this.take();
    const id = job.id;
    for (;;) {
      await this.fail(job, output);
      const after = await this.boss.getJobById(RUN_QUEUE, id);
      if (after?.state === 'failed') return id;
      job = await this.take();
      if (job.id !== id) throw new Error('another job was fetched');
    }
  }
}

/** Works every queued result message and dead letter once, as the server worker would. */
export async function drain(w: ExecWorld, now = new Date()) {
  const worked = { results: 0, deadLetters: 0 };
  for (;;) {
    const [message] = await w.boss.fetch(RESULT_QUEUE);
    if (!message) break;
    await onResultMessage(w.testDb.db, w.boss, RUN_QUEUE, message.data, now);
    await w.boss.complete(RESULT_QUEUE, message.id);
    worked.results++;
  }
  for (;;) {
    const [letter] = await w.boss.fetch(FAILED_QUEUE, { includeMetadata: true });
    if (!letter) break;
    await onDeadLetter(w.testDb.db, letter, now);
    await w.boss.complete(FAILED_QUEUE, letter.id);
    worked.deadLetters++;
  }
  return worked;
}

/**
 * A copy of an existing run row with new ids and the given fields: stands in for rows a crashed
 * or slow process left behind (committed, never sent), which the API cannot be made to leave.
 */
export async function cloneRow(
  w: ExecWorld,
  sourceRunId: string,
  fields: Partial<typeof executionJobs.$inferInsert>,
) {
  const { id: _id, bossJobId: _boss, ...source } = await rowOf(w, sourceRunId);
  const [row] = await w.testDb.db
    .insert(executionJobs)
    .values({
      ...source,
      id: randomUUID(),
      bossJobId: randomUUID(),
      state: 'queued',
      failure: null,
      finishedAt: null,
      supersededBy: null,
      ...fields,
    })
    .returning();
  if (!row) throw new Error('clone returned no row');
  return row;
}

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { expect, inject } from 'vitest';
import { withAdminClient } from '../../src/db/admin';
import type { Db } from '../../src/db/client';
import {
  assignments,
  attemptAnswers,
  auditEvents,
  executionJobs,
  executionResults,
  gradeReleases,
  grades,
  resourceRevisions,
  storageObjects,
  testAttempts,
  testSubmissions,
} from '../../src/db/schema';
import type { Storage } from '../../src/storage/storage';
import { ids } from '../fixtures/world';
import { attemptUrl, call, drain, type ExecWorld, startAttempt } from './execution';

/** Shared by the A22 suites: scripts/backup.sh and scripts/restore.sh with either driver. */

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const CODE = 'def f(xs):\n    return sum(xs) / len(xs)\n';
export const DATASET = new TextEncoder().encode('height_cm\n171\n165\n180\n');

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs scripts/<name>.sh on a database, with the storage variables it should act on. */
export function script(
  name: 'backup' | 'restore',
  dir: string,
  databaseUrl: string,
  storageEnv: Record<string, string>,
) {
  return new Promise<Run>((resolve) => {
    execFile(
      'bash',
      [join(ROOT, 'scripts', `${name}.sh`), dir],
      {
        cwd: ROOT,
        env: { ...process.env, DATABASE_URL: databaseUrl, ...storageEnv },
        timeout: 60_000,
      },
      (err, stdout, stderr) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

/** New, empty databases (not cloned from the migrated template), dropped by dropDatabases. */
const created: string[] = [];
export async function emptyDatabase(): Promise<string> {
  const base = process.env.DATABASE_URL as string;
  const name = `${inject('itestPrefix')}${randomBytes(6).toString('hex')}`;
  await withAdminClient(base, (client) =>
    client.query(`create database ${pg.escapeIdentifier(name)} template template0`),
  );
  created.push(name);
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

export async function dropDatabases() {
  await withAdminClient(process.env.DATABASE_URL as string, async (client) => {
    for (const name of created.splice(0)) {
      await client.query(`drop database if exists ${pg.escapeIdentifier(name)} with (force)`);
    }
  });
}

/** Tables (not counting the catalogs) in a database. */
export async function tableCount(url: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: string }>(
      `select count(*) as n from pg_tables where schemaname not in ('pg_catalog', 'information_schema')`,
    );
    return Number(rows[0]?.n);
  } finally {
    await client.end();
  }
}

/** The records A22 names, every row in a stable order. */
const TABLES: Record<string, PgTable> = {
  resourceRevisions,
  storageObjects,
  assignments,
  testAttempts,
  attemptAnswers,
  testSubmissions,
  executionJobs,
  executionResults,
  grades,
  gradeReleases,
  auditEvents,
};
export async function records(db: Db) {
  const out: Record<string, unknown[]> = {};
  for (const [name, table] of Object.entries(TABLES)) {
    // Every table here has an `id` primary key.
    out[name] = await db.select().from(table).orderBy(sql`id`);
  }
  return out;
}

/** Every byte of a stored object. */
export async function readAll(storage: Storage, key: string) {
  const { body } = await storage.get(key);
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export const resultsUrl = (w: ExecWorld) =>
  `/api/classes/${ids.classB}/resources/${w.quizId}/results`;
export const gradeUrl = (attemptId: string) => `${attemptUrl(ids.classB, attemptId)}/grade`;

export interface Graded {
  attemptId: string;
  revisionId: string;
  datasetKey: string;
  graderVersion: string;
  records: Record<string, unknown[]>;
  results: unknown;
  grade: unknown;
}

/**
 * In an execWorld whose quiz names DATASET: Bea answers every question, submits, and every
 * grading run passes; Marcus grades with attempt and code-line feedback and releases it, and a
 * later draft stays his. Returns what the restore must bring back.
 */
export async function gradedAttempt(w: ExecWorld, submissionKey: string): Promise<Graded> {
  const tick = () => {
    w.clock.now = new Date(w.clock.now.getTime() + 60_000);
    return w.clock.now;
  };

  tick();
  const attemptId = await startAttempt(w, 'bea', ids.classB);
  const url = attemptUrl(ids.classB, attemptId);
  for (const questionId of ['mean', 'median', 'spread']) {
    const saved = await w.app.inject({
      method: 'PUT',
      url: `${url}/answers/${questionId}`,
      headers: { host: '127.0.0.1:3100', cookie: w.world.cookie.bea },
      payload: { value: { files: [{ path: 'solution.py', content: CODE }] }, seq: 1 },
    });
    expect(saved.statusCode).toBe(200);
  }
  const picked = await w.app.inject({
    method: 'PUT',
    url: `${url}/answers/pick`,
    headers: { host: '127.0.0.1:3100', cookie: w.world.cookie.bea },
    payload: { value: ['b'], seq: 1 },
  });
  expect(picked.statusCode).toBe(200);
  const submitted = await call(w, 'bea', 'POST', `${url}/submit`, { submissionKey });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  for (let i = 0; i < 3; i++) await w.runner.finish(await w.runner.take());
  expect(await drain(w)).toEqual({ results: 3, deadLetters: 0 });

  tick();
  const draft = await call(w, 'marcus', 'POST', gradeUrl(attemptId), {
    expectedGradeId: null,
    manual: [],
    feedback: [
      { target: { kind: 'attempt' }, text: 'Clear and correct.' },
      {
        target: { kind: 'line', questionId: 'mean', path: 'solution.py', line: 2 },
        text: 'Guard the empty list.',
      },
    ],
  });
  expect(draft.status).toBe(200);
  tick();
  const release = await call(w, 'marcus', 'POST', `/api/classes/${ids.classB}/grade-releases`, {
    grades: [{ attemptId, gradeId: draft.body.history[0].id }],
  });
  expect(release.status).toBe(201);
  tick();
  const later = await call(w, 'marcus', 'POST', gradeUrl(attemptId), {
    expectedGradeId: draft.body.history[0].id,
    manual: [],
    feedback: [{ target: { kind: 'attempt' }, text: 'Unreleased second thoughts' }],
  });
  expect(later.status).toBe(200);

  const [started] = await w.testDb.db
    .select()
    .from(testAttempts)
    .where(eq(testAttempts.id, attemptId));
  const revisionId = started?.resourceRevisionId as string;
  const [revision] = await w.testDb.db
    .select()
    .from(resourceRevisions)
    .where(eq(resourceRevisions.id, revisionId));
  const datasetKey = revision?.objectKeys[0] as string;
  expect(datasetKey).toMatch(/^courses\/.+\/objects\/[0-9a-f]{64}$/);
  return {
    attemptId,
    revisionId,
    datasetKey,
    graderVersion: started?.graderVersion as string,
    records: await records(w.testDb.db),
    results: (await call(w, 'bea', 'GET', resultsUrl(w))).body,
    grade: (await call(w, 'marcus', 'GET', gradeUrl(attemptId))).body,
  };
}

/** What A22 asserts of a restored database: the attempt and everything it was graded on. */
export function expectRestoredRecords(after: Record<string, unknown[]>, g: Graded) {
  expect(after).toEqual(g.records);
  const [attempt] = after.testAttempts as (typeof testAttempts.$inferSelect)[];
  expect(attempt).toMatchObject({
    id: g.attemptId,
    userId: ids.bea,
    resourceRevisionId: g.revisionId,
    graderVersion: g.graderVersion,
    state: 'released',
  });
  const [submission] = after.testSubmissions as (typeof testSubmissions.$inferSelect)[];
  expect(JSON.stringify(submission?.answers)).toContain(JSON.stringify(CODE));
  const results = after.executionResults as (typeof executionResults.$inferSelect)[];
  expect(results).toHaveLength(3);
  const jobs = after.executionJobs as (typeof executionJobs.$inferSelect)[];
  for (const result of results) {
    const job = jobs.find((j) => j.id === result.jobId);
    expect(job?.attemptId).toBe(g.attemptId);
    expect(result.graderVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(result).toMatchObject({ graderVersion: job?.graderVersion, harnessVersion: '1' });
  }
  const revision = (after.resourceRevisions as (typeof resourceRevisions.$inferSelect)[]).find(
    (r) => r.id === g.revisionId,
  );
  expect(revision?.objectKeys).toEqual([g.datasetKey]);
  expect(JSON.stringify(revision?.content)).toContain('Write mean(xs).');
  const released = (after.grades as (typeof grades.$inferSelect)[]).filter(
    (r) => r.state === 'released',
  );
  expect(released).toHaveLength(1);
}

/** What A22 asserts the restored application shows: the released feedback, and only it. */
export function expectReleasedFeedback(
  // biome-ignore lint/suspicious/noExplicitAny: assertions walk the response freely.
  results: { status: number; body: any },
  // biome-ignore lint/suspicious/noExplicitAny: assertions walk the response freely.
  grade: { status: number; body: any },
  g: Graded,
) {
  expect(results.status).toBe(200);
  expect(results.body).toEqual(g.results);
  expect(results.body.attempts[0]).toMatchObject({
    attemptId: g.attemptId,
    status: 'released',
    grade: {
      feedback: [
        { target: { kind: 'attempt' }, text: 'Clear and correct.' },
        {
          target: { kind: 'line', questionId: 'mean', path: 'solution.py', line: 2 },
          text: 'Guard the empty list.',
        },
      ],
    },
  });
  expect(JSON.stringify(results.body)).not.toContain('Unreleased');
  expect(grade.status).toBe(200);
  expect(grade.body).toEqual(g.grade);
  expect(grade.body.history.map((h: { state: string }) => h.state)).toEqual(['draft', 'released']);
}

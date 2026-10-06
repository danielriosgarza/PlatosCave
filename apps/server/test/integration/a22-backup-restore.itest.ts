import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { buildApp } from '../../src/app';
import { withAdminClient } from '../../src/db/admin';
import { createDb, type Db } from '../../src/db/client';
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
import { FsStorage } from '../../src/storage/fs';
import { ids, type PersonName } from '../fixtures/world';
import {
  attemptUrl,
  call,
  config,
  drain,
  type ExecWorld,
  execWorld,
  startAttempt,
} from './execution';

/**
 * Backup and restore (§13, A22): scripts/backup.sh takes the fixture world with a submitted,
 * graded and released attempt; the source database and storage root are then dropped, and
 * scripts/restore.sh brings both back into a fresh database and storage root. The restored
 * attempt keeps its resource revision (with its stored file), code, grader version and released
 * feedback, and the application serves them as before. Class B: Marcus teaches Bea.
 */

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CODE = 'def f(xs):\n    return sum(xs) / len(xs)\n';
const DATASET = new TextEncoder().encode('height_cm\n171\n165\n180\n');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs scripts/<name>.sh with the database and storage root it should act on. */
function script(name: 'backup' | 'restore', dir: string, databaseUrl: string, storageDir: string) {
  return new Promise<Run>((resolve) => {
    execFile(
      'bash',
      [join(ROOT, 'scripts', `${name}.sh`), dir],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          STORAGE_DRIVER: 'fs',
          STORAGE_DIR: storageDir,
        },
        timeout: 60_000,
      },
      (err, stdout, stderr) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

/** A new, empty database (not cloned from the migrated template), dropped with the run. */
const created: string[] = [];
async function emptyDatabase(): Promise<string> {
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
async function records(db: Db) {
  const out: Record<string, unknown[]> = {};
  for (const [name, table] of Object.entries(TABLES)) {
    // Every table here has an `id` primary key.
    out[name] = await db.select().from(table).orderBy(sql`id`);
  }
  return out;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

let w: ExecWorld;
let tmp: string;
let attemptId: string;
let revisionId: string;
let datasetKey: string;
let graderVersion: string;
const before: {
  records?: Record<string, unknown[]>;
  results?: unknown;
  grade?: unknown;
} = {};
let restored: { url: string; db: Db; end: () => Promise<void>; app: FastifyInstance };
const clock = { now: new Date() };

/** A request as a person against the restored application. */
async function restoredCall(who: PersonName, url: string) {
  const res = await restored.app.inject({
    method: 'GET',
    url,
    headers: { host: '127.0.0.1:3100', cookie: w.world.cookie[who] },
  });
  // biome-ignore lint/suspicious/noExplicitAny: assertions walk the response freely.
  return { status: res.statusCode, body: res.json() as any };
}

const resultsUrl = () => `/api/classes/${ids.classB}/resources/${w.quizId}/results`;
const gradeUrl = () => `${attemptUrl(ids.classB, attemptId)}/grade`;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'parallax-backup-'));
  const source = join(tmp, 'source-storage');
  w = await execWorld({
    storage: new FsStorage(source),
    quizObjects: [{ bytes: DATASET, contentType: 'text/csv' }],
  });
  const tick = () => {
    w.clock.now = new Date(w.clock.now.getTime() + 60_000);
    return w.clock.now;
  };

  // Bea answers every question, submits, and every grading run passes.
  tick();
  attemptId = await startAttempt(w, 'bea', ids.classB);
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
  const submitted = await call(w, 'bea', 'POST', `${url}/submit`, {
    submissionKey: 'a22-bea-backup',
  });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  for (let i = 0; i < 3; i++) await w.runner.finish(await w.runner.take());
  expect(await drain(w)).toEqual({ results: 3, deadLetters: 0 });

  // Marcus grades with attempt and code-line feedback and releases it; a later draft stays his.
  tick();
  const draft = await call(w, 'marcus', 'POST', gradeUrl(), {
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
  const later = await call(w, 'marcus', 'POST', gradeUrl(), {
    expectedGradeId: draft.body.history[0].id,
    manual: [],
    feedback: [{ target: { kind: 'attempt' }, text: 'Unreleased second thoughts' }],
  });
  expect(later.status).toBe(200);

  const [started] = await w.testDb.db
    .select()
    .from(testAttempts)
    .where(eq(testAttempts.id, attemptId));
  revisionId = started?.resourceRevisionId as string;
  graderVersion = started?.graderVersion as string;
  const [revision] = await w.testDb.db
    .select()
    .from(resourceRevisions)
    .where(eq(resourceRevisions.id, revisionId));
  datasetKey = revision?.objectKeys[0] as string;
  expect(datasetKey).toMatch(/^courses\/.+\/objects\/[0-9a-f]{64}$/);
  before.records = await records(w.testDb.db);
  before.results = (await call(w, 'bea', 'GET', resultsUrl())).body;
  before.grade = (await call(w, 'marcus', 'GET', gradeUrl())).body;
  clock.now = w.clock.now;

  // Back up, then lose the originals: the restore has nothing else to draw on.
  const backup = await script('backup', join(tmp, 'backup'), w.testDb.url, source);
  expect(backup, backup.stderr).toMatchObject({ code: 0 });
  await w.close();
  await rm(source, { recursive: true, force: true });

  const url2 = await emptyDatabase();
  const storageDir = join(tmp, 'restored-storage');
  const restore = await script('restore', join(tmp, 'backup'), url2, storageDir);
  expect(restore, restore.stderr).toMatchObject({ code: 0 });
  const { db, pool } = createDb(url2);
  const app = await buildApp(config, {
    db,
    now: () => clock.now,
    storage: new FsStorage(storageDir),
  });
  await app.ready();
  restored = { url: url2, db, end: () => pool.end(), app };
}, 120_000);

afterAll(async () => {
  await restored?.app.close();
  await restored?.end();
  const base = process.env.DATABASE_URL as string;
  await withAdminClient(base, async (client) => {
    for (const name of created) {
      await client.query(`drop database if exists ${pg.escapeIdentifier(name)} with (force)`);
    }
  });
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe('A22 backup and restore', () => {
  test('A22 the restored attempt keeps its resource revision, code, grader version and grades', async () => {
    const after = await records(restored.db);
    expect(after).toEqual(before.records);

    const [attempt] = after.testAttempts as (typeof testAttempts.$inferSelect)[];
    expect(attempt).toMatchObject({
      id: attemptId,
      userId: ids.bea,
      resourceRevisionId: revisionId,
      graderVersion,
      state: 'released',
    });
    const [submission] = after.testSubmissions as (typeof testSubmissions.$inferSelect)[];
    expect(JSON.stringify(submission?.answers)).toContain(JSON.stringify(CODE));
    const results = after.executionResults as (typeof executionResults.$inferSelect)[];
    expect(results).toHaveLength(3);
    const jobs = after.executionJobs as (typeof executionJobs.$inferSelect)[];
    for (const result of results) {
      const job = jobs.find((j) => j.id === result.jobId);
      expect(job?.attemptId).toBe(attemptId);
      expect(result.graderVersion).toMatch(/^[0-9a-f]{16}$/);
      expect(result).toMatchObject({ graderVersion: job?.graderVersion, harnessVersion: '1' });
    }
    const revision = (after.resourceRevisions as (typeof resourceRevisions.$inferSelect)[]).find(
      (r) => r.id === revisionId,
    );
    expect(revision?.objectKeys).toEqual([datasetKey]);
    expect(JSON.stringify(revision?.content)).toContain('Write mean(xs).');
    const released = (after.grades as (typeof grades.$inferSelect)[]).filter(
      (g) => g.state === 'released',
    );
    expect(released).toHaveLength(1);
  });

  test('A22 every stored object the database names is restored byte for byte', async () => {
    const storage = new FsStorage(join(tmp, 'restored-storage'));
    const objects = await restored.db.select().from(storageObjects);
    expect(objects.map((o) => o.key)).toEqual([datasetKey]);
    for (const object of objects) {
      const { body } = await storage.get(object.key);
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(chunk as Buffer);
      const bytes = Buffer.concat(chunks);
      expect(sha256(bytes)).toBe(object.sha256);
      expect(bytes.length).toBe(object.size);
    }
    const { body } = await storage.get(datasetKey);
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(chunk as Buffer);
    expect(new Uint8Array(Buffer.concat(chunks))).toEqual(DATASET);
  });

  test('A22 the restored application shows the student the released feedback, and only it', async () => {
    const results = await restoredCall('bea', resultsUrl());
    expect(results.status).toBe(200);
    expect(results.body).toEqual(before.results);
    expect(results.body.attempts[0]).toMatchObject({
      attemptId,
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

    const grade = await restoredCall('marcus', gradeUrl());
    expect(grade.status).toBe(200);
    expect(grade.body).toEqual(before.grade);
    expect(grade.body.history.map((g: { state: string }) => g.state)).toEqual([
      'draft',
      'released',
    ]);
  });

  test('A22 the backup lists every object with its digest and size', async () => {
    const dir = join(tmp, 'backup');
    expect((await readdir(dir)).sort()).toEqual([
      'backup.info',
      'database.dump',
      'storage',
      'storage.manifest',
    ]);
    const manifest = await readFile(join(dir, 'storage.manifest'), 'utf8');
    expect(manifest).toBe(`${sha256(DATASET)}\t${DATASET.length}\t${datasetKey}\n`);
    const info = await readFile(join(dir, 'backup.info'), 'utf8');
    expect(info).toContain('format=parallax-backup/1\n');
    expect(info).toContain(
      `database_sha256=${sha256(await readFile(join(dir, 'database.dump')))}\n`,
    );
    expect(info).toContain('objects=1\n');
  });
});

describe('A22 restore refuses what it cannot restore faithfully', () => {
  const tableCount = async (url: string) => {
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
  };

  test('A22 a database that already holds data is left untouched', async () => {
    const storageDir = join(tmp, 'refused-storage');
    const res = await script('restore', join(tmp, 'backup'), restored.url, storageDir);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('the target database is not empty');
    await expect(readdir(storageDir)).rejects.toThrow();
    const [attempt] = await restored.db
      .select()
      .from(testAttempts)
      .where(eq(testAttempts.id, attemptId));
    expect(attempt?.state).toBe('released');
  });

  test('A22 a storage root that already holds objects is left untouched', async () => {
    const url = await emptyDatabase();
    const storageDir = join(tmp, 'occupied-storage');
    await mkdir(storageDir);
    await writeFile(join(storageDir, 'keep.txt'), 'mine');
    const res = await script('restore', join(tmp, 'backup'), url, storageDir);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain(`storage root ${storageDir} is not empty`);
    expect(await readdir(storageDir)).toEqual(['keep.txt']);
    expect(await tableCount(url)).toBe(0);
  });

  test('A22 a backup with a corrupted object restores nothing', async () => {
    const copy = join(tmp, 'corrupted');
    await cp(join(tmp, 'backup'), copy, { recursive: true });
    await writeFile(join(copy, 'storage', datasetKey), 'height_cm\n999\n');
    const url = await emptyDatabase();
    const storageDir = join(tmp, 'corrupted-storage');
    const res = await script('restore', copy, url, storageDir);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('do not match their digests');
    expect(await tableCount(url)).toBe(0);
    await expect(readdir(storageDir)).rejects.toThrow();
  });

  test('A22 a backup with a changed database dump restores nothing', async () => {
    const copy = join(tmp, 'changed-dump');
    await cp(join(tmp, 'backup'), copy, { recursive: true });
    await writeFile(join(copy, 'database.dump'), 'not the dump');
    const url = await emptyDatabase();
    const res = await script('restore', copy, url, join(tmp, 'changed-dump-storage'));
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('database.dump does not match the digest in backup.info');
    expect(await tableCount(url)).toBe(0);
  });

  test('A22 backup refuses a storage root holding an object whose bytes do not match its key', async () => {
    const root = join(tmp, 'bad-root');
    const key = `courses/${ids.statistics}/objects/${'0'.repeat(64)}`;
    await mkdir(join(root, key, '..'), { recursive: true });
    await writeFile(join(root, key), 'not zero');
    const res = await script('backup', join(tmp, 'bad-backup'), restored.url, root);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain(`digest of ${key} is`);
    await expect(readdir(join(tmp, 'bad-backup'))).rejects.toThrow();
    await expect(readdir(join(tmp, 'bad-backup.partial'))).rejects.toThrow();
  });
});

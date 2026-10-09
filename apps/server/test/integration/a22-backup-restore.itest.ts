import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { createDb, type Db } from '../../src/db/client';
import { storageObjects, testAttempts } from '../../src/db/schema';
import { FsStorage } from '../../src/storage/fs';
import { ids, type PersonName } from '../fixtures/world';
import {
  DATASET,
  dropDatabases,
  emptyDatabase,
  expectReleasedFeedback,
  expectRestoredRecords,
  type Graded,
  gradedAttempt,
  gradeUrl,
  readAll,
  records,
  resultsUrl,
  script as run,
  sha256,
  tableCount,
} from './backup';
import { config, type ExecWorld, execWorld } from './execution';

/**
 * Backup and restore (§13, A22): scripts/backup.sh takes the fixture world with a submitted,
 * graded and released attempt; the source database and storage root are then dropped, and
 * scripts/restore.sh brings both back into a fresh database and storage root. The restored
 * attempt keeps its resource revision (with its stored file), code, grader version and released
 * feedback, and the application serves them as before. Class B: Marcus teaches Bea.
 * a22-backup-restore-s3.itest.ts does the same with STORAGE_DRIVER=s3.
 */

/** Runs scripts/<name>.sh with the database and storage root it should act on. */
const script = (name: 'backup' | 'restore', dir: string, databaseUrl: string, storageDir: string) =>
  run(name, dir, databaseUrl, { STORAGE_DRIVER: 'fs', STORAGE_DIR: storageDir });

let w: ExecWorld;
let tmp: string;
let g: Graded;
let restored: { url: string; db: Db; end: () => Promise<void>; app: FastifyInstance };

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

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'parallax-backup-'));
  const source = join(tmp, 'source-storage');
  w = await execWorld({
    storage: new FsStorage(source),
    quizObjects: [{ bytes: DATASET, contentType: 'text/csv' }],
  });
  g = await gradedAttempt(w, 'a22-bea-backup');

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
    now: () => w.clock.now,
    storage: new FsStorage(storageDir),
  });
  await app.ready();
  restored = { url: url2, db, end: () => pool.end(), app };
}, 120_000);

afterAll(async () => {
  await restored?.app.close();
  await restored?.end();
  await dropDatabases();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe('A22 backup and restore', () => {
  test('A22 the restored attempt keeps its resource revision, code, grader version and grades', async () => {
    expectRestoredRecords(await records(restored.db), g);
  });

  test('A22 every stored object the database names is restored byte for byte', async () => {
    const storage = new FsStorage(join(tmp, 'restored-storage'));
    const objects = await restored.db.select().from(storageObjects);
    expect(objects.map((o) => o.key)).toEqual([g.datasetKey]);
    for (const object of objects) {
      const bytes = await readAll(storage, object.key);
      expect(sha256(bytes)).toBe(object.sha256);
      expect(bytes.length).toBe(object.size);
    }
    expect(new Uint8Array(await readAll(storage, g.datasetKey))).toEqual(DATASET);
  });

  test('A22 the restored storage root is readable by users other than its owner', async () => {
    const mode = (await stat(join(tmp, 'restored-storage'))).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  test('A22 the restored application shows the student the released feedback, and only it', async () => {
    expectReleasedFeedback(
      await restoredCall('bea', resultsUrl(w)),
      await restoredCall('marcus', gradeUrl(g.attemptId)),
      g,
    );
  });

  test('A22 the backup is private to its owner: directories 0700, files 0600', async () => {
    const dir = join(tmp, 'backup');
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(entries.length).toBeGreaterThan(4);
    for (const entry of entries) {
      const mode = (await stat(join(entry.parentPath, entry.name))).mode & 0o777;
      expect(mode, join(entry.parentPath, entry.name)).toBe(entry.isDirectory() ? 0o700 : 0o600);
    }
  });

  test('A22 a backup taken under umask 000 from world-readable objects is still private', async () => {
    const root = join(tmp, 'open-root');
    const key = `courses/${ids.statistics}/objects/${sha256(DATASET)}`;
    await mkdir(join(root, key, '..'), { recursive: true });
    await writeFile(join(root, key), DATASET);
    await chmod(join(root, key), 0o666);
    const dir = join(tmp, 'open-backup');
    const res = await run(
      'backup',
      dir,
      restored.url,
      { STORAGE_DRIVER: 'fs', STORAGE_DIR: root },
      '000',
    );
    expect(res, res.stderr).toMatchObject({ code: 0 });
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'database.dump'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'storage', key))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'storage', 'courses'))).mode & 0o777).toBe(0o700);
    // The owner can still restore from it, and the restored storage root stays readable by the API.
    const storageDir = join(tmp, 'open-restored');
    const restore = await script('restore', dir, await emptyDatabase(), storageDir);
    expect(restore, restore.stderr).toMatchObject({ code: 0 });
    expect((await stat(join(storageDir, key))).mode & 0o777).toBe(0o644);
    expect((await stat(join(storageDir, 'courses'))).mode & 0o777).toBe(0o755);
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
    expect(manifest).toBe(`${sha256(DATASET)}\t${DATASET.length}\t${g.datasetKey}\n`);
    const info = await readFile(join(dir, 'backup.info'), 'utf8');
    expect(info).toContain('format=parallax-backup/1\n');
    expect(info).toContain(
      `database_sha256=${sha256(await readFile(join(dir, 'database.dump')))}\n`,
    );
    expect(info).toContain('objects=1\n');
  });
});

describe('A22 restore refuses what it cannot restore faithfully', () => {
  test('A22 a database that already holds data is left untouched', async () => {
    const storageDir = join(tmp, 'refused-storage');
    const res = await script('restore', join(tmp, 'backup'), restored.url, storageDir);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('the target database is not empty');
    await expect(readdir(storageDir)).rejects.toThrow();
    const [attempt] = await restored.db
      .select()
      .from(testAttempts)
      .where(eq(testAttempts.id, g.attemptId));
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

  test.each([
    ['function', 'create function public.f() returns int language sql as $$ select 1 $$'],
    ['type', `create type public.mood as enum ('ok')`],
  ])('A22 a database holding only a %s in public is refused', async (_kind, ddl) => {
    const url = await emptyDatabase();
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(ddl);
    } finally {
      await client.end();
    }
    const storageDir = join(tmp, 'ddl-refused-storage');
    const res = await script('restore', join(tmp, 'backup'), url, storageDir);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('the target database is not empty');
    expect(await tableCount(url)).toBe(0);
    await expect(readdir(storageDir)).rejects.toThrow();
  });

  test('A22 an existing empty storage root is filled in place and keeps its mode', async () => {
    const url = await emptyDatabase();
    const storageDir = join(tmp, 'mounted-storage');
    await mkdir(storageDir);
    await chmod(storageDir, 0o750);
    const { ino } = await stat(storageDir);
    const res = await script('restore', join(tmp, 'backup'), url, storageDir);
    expect(res, res.stderr).toMatchObject({ code: 0 });
    const after = await stat(storageDir);
    expect(after.ino).toBe(ino);
    expect(after.mode & 0o777).toBe(0o750);
    expect(new Uint8Array(await readAll(new FsStorage(storageDir), g.datasetKey))).toEqual(DATASET);
    expect((await readdir(tmp)).filter((n) => n.startsWith('.restore-'))).toEqual([]);
  });

  test('A22 a backup with a corrupted object restores nothing', async () => {
    const copy = join(tmp, 'corrupted');
    await cp(join(tmp, 'backup'), copy, { recursive: true });
    await writeFile(join(copy, 'storage', g.datasetKey), 'height_cm\n999\n');
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

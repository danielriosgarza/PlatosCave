import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { createDb, type Db } from '../../src/db/client';
import { storageObjects } from '../../src/db/schema';
import { S3Storage } from '../../src/storage/s3';
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
  script,
  sha256,
  tableCount,
} from './backup';
import { config, type ExecWorld, execWorld } from './execution';

/**
 * A22 with STORAGE_DRIVER=s3 (P4-07a): the same graded attempt as a22-backup-restore.itest.ts,
 * stored in a bucket of the Garage service (infra/compose.yml, profile `s3`, prepared by
 * scripts/garage-init.sh). scripts/backup.sh snapshots the bucket into the parallax-backup/1
 * layout; the source database and bucket are then dropped, and scripts/restore.sh brings both
 * back into a fresh database and an empty bucket. Each run creates its own buckets. Skipped
 * without the S3_* variables locally; mandatory in CI.
 */
const env = process.env;

test.runIf(env.CI)('CI provides the Garage S3 endpoint for A22', () => {
  expect(env.S3_ENDPOINT).toBeTruthy();
});

describe.skipIf(!env.S3_ENDPOINT)('A22 backup and restore with the s3 driver', () => {
  const settings = {
    endpoint: env.S3_ENDPOINT as string,
    region: env.S3_REGION ?? 'garage',
    accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
    forcePathStyle: true,
  };
  const client = new S3Client({
    region: settings.region,
    endpoint: settings.endpoint,
    forcePathStyle: true,
    credentials: settings,
  });
  const run = `a22-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const buckets: string[] = [];
  /** A new bucket of this run, deleted with its objects afterwards. */
  async function bucket(name: string) {
    const full = `${run}-${name}`;
    await client.send(new CreateBucketCommand({ Bucket: full }));
    buckets.push(full);
    return full;
  }
  async function keysOf(name: string) {
    const res = await client.send(new ListObjectsV2Command({ Bucket: name }));
    return (res.Contents ?? []).map((o) => o.Key as string).sort();
  }
  const put = (name: string, key: string, body: string) =>
    client.send(new PutObjectCommand({ Bucket: name, Key: key, Body: body }));
  const s3 = (name: string) => ({
    STORAGE_DRIVER: 's3',
    S3_ENDPOINT: settings.endpoint,
    S3_REGION: settings.region,
    S3_BUCKET: name,
    S3_ACCESS_KEY_ID: settings.accessKeyId,
    S3_SECRET_ACCESS_KEY: settings.secretAccessKey,
    S3_FORCE_PATH_STYLE: 'true',
  });

  let w: ExecWorld;
  let tmp: string;
  let g: Graded;
  let target: string;
  let restored: { url: string; db: Db; end: () => Promise<void>; app: FastifyInstance };

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
    tmp = await mkdtemp(join(tmpdir(), 'parallax-backup-s3-'));
    const source = await bucket('source');
    const sourceStorage = new S3Storage({ ...settings, bucket: source });
    w = await execWorld({
      storage: sourceStorage,
      quizObjects: [{ bytes: DATASET, contentType: 'text/csv' }],
    });
    g = await gradedAttempt(w, 'a22-bea-backup-s3');
    // An upload still in flight: not an object yet, so not in the backup.
    await put(source, 'tmp/in-flight', 'partial');

    const backup = await script('backup', join(tmp, 'backup'), w.testDb.url, s3(source));
    expect(backup, backup.stderr).toMatchObject({ code: 0 });
    await w.close();
    for (const key of await keysOf(source)) {
      await client.send(new DeleteObjectCommand({ Bucket: source, Key: key }));
    }
    expect(await keysOf(source)).toEqual([]);

    const url2 = await emptyDatabase();
    target = await bucket('restored');
    const restore = await script('restore', join(tmp, 'backup'), url2, s3(target));
    expect(restore, restore.stderr).toMatchObject({ code: 0 });
    const { db, pool } = createDb(url2);
    const app = await buildApp(config, {
      db,
      now: () => w.clock.now,
      storage: new S3Storage({ ...settings, bucket: target }),
    });
    await app.ready();
    restored = { url: url2, db, end: () => pool.end(), app };
  }, 120_000);

  afterAll(async () => {
    await restored?.app.close();
    await restored?.end();
    await dropDatabases();
    for (const name of buckets) {
      for (const key of await keysOf(name)) {
        await client.send(new DeleteObjectCommand({ Bucket: name, Key: key }));
      }
      await client.send(new DeleteBucketCommand({ Bucket: name }));
    }
    client.destroy();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  test('A22 s3: the restored attempt keeps its resource revision, code, grader version and grades', async () => {
    expectRestoredRecords(await records(restored.db), g);
  });

  test('A22 s3: the bucket holds every object the database names, byte for byte, and nothing else', async () => {
    const storage = new S3Storage({ ...settings, bucket: target });
    try {
      const objects = await restored.db.select().from(storageObjects);
      expect(objects.map((o) => o.key)).toEqual([g.datasetKey]);
      for (const object of objects) {
        const bytes = await readAll(storage, object.key);
        expect(sha256(bytes)).toBe(object.sha256);
        expect(bytes.length).toBe(object.size);
      }
      expect(new Uint8Array(await readAll(storage, g.datasetKey))).toEqual(DATASET);
      expect(await keysOf(target)).toEqual([g.datasetKey]);
    } finally {
      storage.destroy();
    }
  });

  test('A22 s3: the restored application shows the student the released feedback, and only it', async () => {
    expectReleasedFeedback(
      await restoredCall('bea', resultsUrl(w)),
      await restoredCall('marcus', gradeUrl(g.attemptId)),
      g,
    );
  });

  test('A22 s3: the backup has the parallax-backup/1 layout and lists every object', async () => {
    const dir = join(tmp, 'backup');
    expect((await readdir(dir)).sort()).toEqual([
      'backup.info',
      'database.dump',
      'storage',
      'storage.manifest',
    ]);
    expect(await readFile(join(dir, 'storage.manifest'), 'utf8')).toBe(
      `${sha256(DATASET)}\t${DATASET.length}\t${g.datasetKey}\n`,
    );
    expect(new Uint8Array(await readFile(join(dir, 'storage', g.datasetKey)))).toEqual(DATASET);
    const info = await readFile(join(dir, 'backup.info'), 'utf8');
    expect(info).toContain('format=parallax-backup/1\n');
    expect(info).toContain('storage_driver=s3\n');
    expect(info).toContain('objects=1\n');
  });

  test('A22 s3: a bucket that already holds objects is left untouched', async () => {
    const url = await emptyDatabase();
    const occupied = await bucket('occupied');
    await put(occupied, 'keep.txt', 'mine');
    const res = await script('restore', join(tmp, 'backup'), url, s3(occupied));
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain(`bucket ${occupied} is not an empty bucket`);
    expect(await keysOf(occupied)).toEqual(['keep.txt']);
    expect(await tableCount(url)).toBe(0);
  });

  test('A22 s3: a backup with a corrupted object restores nothing', async () => {
    const copy = join(tmp, 'corrupted');
    await cp(join(tmp, 'backup'), copy, { recursive: true });
    await writeFile(join(copy, 'storage', g.datasetKey), 'height_cm\n999\n');
    const url = await emptyDatabase();
    const empty = await bucket('corrupted');
    const res = await script('restore', copy, url, s3(empty));
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('do not match their digests');
    expect(await tableCount(url)).toBe(0);
    expect(await keysOf(empty)).toEqual([]);
  });

  test('A22 s3: a failed database restore removes the objects it uploaded', async () => {
    // Empty by every check restore.sh makes, but without the schema the dump restores into.
    const url = await emptyDatabase();
    const db = new pg.Client({ connectionString: url });
    await db.connect();
    try {
      await db.query('drop schema public');
    } finally {
      await db.end();
    }
    const empty = await bucket('rolled-back');
    const res = await script('restore', join(tmp, 'backup'), url, s3(empty));
    expect(res.code).not.toBe(0);
    expect(await tableCount(url)).toBe(0);
    expect(await keysOf(empty)).toEqual([]);
  });

  test('A22 s3: backup refuses a bucket object whose bytes do not match its key', async () => {
    const bad = await bucket('bad-digest');
    const key = `courses/${ids.statistics}/objects/${'0'.repeat(64)}`;
    await put(bad, key, 'not zero');
    const res = await script('backup', join(tmp, 'bad-backup'), restored.url, s3(bad));
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain(`digest of ${key} is`);
    await expect(readdir(join(tmp, 'bad-backup'))).rejects.toThrow();
    await expect(readdir(join(tmp, 'bad-backup.partial'))).rejects.toThrow();
  });

  test('A22 s3: backup refuses a bucket holding keys that are not content-addressed objects', async () => {
    const odd = await bucket('odd-key');
    await put(odd, 'courses/notes.txt', 'x');
    const res = await script('backup', join(tmp, 'odd-backup'), restored.url, s3(odd));
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('not content-addressed objects: "courses/notes.txt"');
    await expect(readdir(join(tmp, 'odd-backup'))).rejects.toThrow();
  });
});

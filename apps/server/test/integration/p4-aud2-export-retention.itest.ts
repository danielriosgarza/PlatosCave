import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { removeUnreferencedObjects, UNREFERENCED_OBJECT_MIN_AGE_MS } from '../../src/db/lifecycle';
import { FsStorage } from '../../src/storage/fs';
import { classExportPrefix } from '../../src/storage/storage';
import { ids } from '../fixtures/world';
import { call, type ExecWorld, execWorld, startAttempt } from './execution';

/**
 * A21 (export retention): a results export carries students' names and grades, so it does not
 * outlive its short download window, and a deleted student's name is gone from storage once the
 * sweep has run (P4-AUD2, §13).
 */

let w: ExecWorld;
let root: string;
let storage: FsStorage;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'parallax-export-retention-'));
  storage = new FsStorage(root);
  w = await execWorld({ storage });
  await startAttempt(w, 'sam', ids.classB);
});

afterAll(async () => {
  await w?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

/** Every stored export of a class, as text. */
async function storedExports(classId: string): Promise<string[]> {
  const texts: string[] = [];
  for await (const object of storage.list(classExportPrefix(classId))) {
    const { body } = await storage.get(object.key);
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    texts.push(Buffer.concat(chunks).toString('utf8'));
  }
  return texts;
}

describe('results export retention (P4-AUD2)', () => {
  test('A21 a deleted student’s name does not stay in a stored results export past the sweep', async () => {
    const made = await call(w, 'marcus', 'POST', `/api/classes/${ids.classB}/exports/results`);
    expect(made.status).toBe(201);
    const before = await storedExports(ids.classB);
    expect(before).toHaveLength(1);
    expect(before[0]).toContain('Sam Okafor');

    const deleted = await call(w, 'sam', 'POST', '/api/me/delete', { confirm: true });
    expect(deleted.status).toBe(200);

    // A fresh export is not a candidate yet: its download link may still be in use.
    expect(await removeUnreferencedObjects(w.testDb.db, storage, new Date())).toEqual({
      objectsRemoved: 0,
    });
    expect(await storedExports(ids.classB)).toHaveLength(1);

    const later = new Date(Date.now() + UNREFERENCED_OBJECT_MIN_AGE_MS + 60_000);
    expect(await removeUnreferencedObjects(w.testDb.db, storage, later)).toEqual({
      objectsRemoved: 1,
    });
    const after = await storedExports(ids.classB);
    expect(after.filter((text) => text.includes('Sam Okafor'))).toEqual([]);
    expect(after).toEqual([]);
  });
});

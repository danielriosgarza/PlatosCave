import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { FsStorage } from './fs';
import { courseObjectPrefix, StorageNotFoundError } from './storage';

const prefix = courseObjectPrefix('00000000-0000-4000-8000-000000000101');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

let root: string;
let storage: FsStorage;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'parallax-storage-'));
  storage = new FsStorage(root);
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('fs storage', () => {
  test('streams an object in and out under its content-addressed key', async () => {
    async function* chunks() {
      yield Buffer.from('hello ');
      yield Buffer.from('world');
    }
    const stored = await storage.put(prefix, chunks());
    expect(stored).toEqual({
      key: `${prefix}/objects/${sha('hello world')}`,
      sha256: sha('hello world'),
      size: 11,
    });
    const got = await storage.get(stored.key);
    expect(got.size).toBe(11);
    expect(await text(got.body)).toBe('hello world');
    expect(await storage.head(stored.key)).toEqual({ size: 11 });
  });

  test('identical bytes share one object and leave no temporary files', async () => {
    const a = await storage.put(prefix, Buffer.from('same'));
    const b = await storage.put(prefix, Readable.from([Buffer.from('sa'), Buffer.from('me')]));
    expect(b.key).toBe(a.key);
    expect(await readdir(join(root, prefix, 'objects'))).toEqual([a.sha256]);
    expect(await readdir(join(root, '.tmp'))).toEqual([]);
  });

  test('missing objects report not found; delete is idempotent', async () => {
    const key = `${prefix}/objects/${sha('absent')}`;
    await expect(storage.get(key)).rejects.toBeInstanceOf(StorageNotFoundError);
    expect(await storage.head(key)).toBeNull();
    const stored = await storage.put(prefix, Buffer.from('gone'));
    await storage.delete(stored.key);
    await storage.delete(stored.key);
    expect(await storage.head(stored.key)).toBeNull();
  });

  test('rejects keys that could escape the storage root', async () => {
    for (const key of ['../etc/passwd', '/etc/passwd', 'courses/../x', 'a//b', 'a/./b', '']) {
      await expect(storage.get(key)).rejects.toThrow(/unsafe storage key/);
      await expect(storage.put(key, Buffer.from('x'))).rejects.toThrow(/unsafe storage key/);
    }
  });
});

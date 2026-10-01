import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  assertSafeKey,
  type Body,
  hashingMeter,
  objectKey,
  type Storage,
  StorageNotFoundError,
  type StoredObject,
  toReadable,
} from './storage';

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT';

/** Filesystem adapter for development and tests (`STORAGE_DRIVER=fs`). */
export class FsStorage implements Storage {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    assertSafeKey(key);
    return join(this.root, key);
  }

  async put(prefix: string, body: Body): Promise<StoredObject> {
    assertSafeKey(prefix);
    // Write under a temporary name while hashing, then rename into the content-addressed key.
    const tmpDir = join(this.root, '.tmp');
    await mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, randomUUID());
    const { meter, result } = hashingMeter();
    const source = toReadable(body);
    try {
      await pipeline(source, meter, createWriteStream(tmp, { flags: 'wx' }));
      const { sha256, size } = result();
      const key = objectKey(prefix, sha256);
      const dest = this.path(key);
      await mkdir(dirname(dest), { recursive: true });
      // Same key means same bytes, so replacing an existing object is harmless and atomic.
      await rename(tmp, dest);
      return { key, sha256, size };
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async get(key: string): Promise<{ body: Readable; size: number }> {
    try {
      const handle = await open(this.path(key), 'r');
      const { size } = await handle.stat().catch(async (err) => {
        await handle.close();
        throw err;
      });
      return { body: handle.createReadStream(), size };
    } catch (err) {
      if (isMissing(err)) throw new StorageNotFoundError(key);
      throw err;
    }
  }

  async head(key: string): Promise<{ size: number } | null> {
    try {
      return { size: (await stat(this.path(key))).size };
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

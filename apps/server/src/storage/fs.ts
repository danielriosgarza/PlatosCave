import { randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { access, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  assertSafeKey,
  type Body,
  type ByteRange,
  hashingMeter,
  type ListedObject,
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

  async get(key: string, range?: ByteRange): Promise<{ body: Readable; size: number }> {
    try {
      const handle = await open(this.path(key), 'r');
      const { size } = await handle.stat().catch(async (err) => {
        await handle.close();
        throw err;
      });
      return { body: handle.createReadStream(range), size };
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

  /** The root exists (it is created on first use) and is a directory the process can write. */
  async ping(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await access(this.root, constants.W_OK);
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async *list(prefix: string): AsyncIterable<ListedObject> {
    const dir = this.path(prefix);
    const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch((err) => {
      if (isMissing(err)) return [];
      throw err;
    });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = join(entry.parentPath, entry.name);
      try {
        const { mtime } = await stat(file);
        yield { key: `${prefix}/${relative(dir, file).split(sep).join('/')}`, modifiedAt: mtime };
      } catch (err) {
        // Deleted since the directory was read: it is no longer there to list.
        if (!isMissing(err)) throw err;
      }
    }
  }
}

import { createHash } from 'node:crypto';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, test } from 'vitest';
import { S3Storage } from './s3';
import { courseObjectPrefix } from './storage';

/**
 * The adapter against a backend whose HEAD responses carry no Content-Length (allowed for HEAD).
 * The bytes-in/bytes-out contract runs against Garage in the Docker integration suite.
 */
function fakeBackend() {
  const objects = new Set<string>();
  const sent: string[] = [];
  const client = new S3Client({
    endpoint: 'http://127.0.0.1:1',
    region: 'test',
    forcePathStyle: true,
    credentials: { accessKeyId: 'k', secretAccessKey: 's' },
  });
  client.send = (async (cmd: unknown) => {
    const input = (cmd as { input: { Key: string } }).input;
    sent.push(`${(cmd as object).constructor.name} ${input.Key}`);
    if (cmd instanceof PutObjectCommand) objects.add(input.Key);
    else if (cmd instanceof CopyObjectCommand) objects.add(input.Key);
    else if (cmd instanceof DeleteObjectCommand) objects.delete(input.Key);
    else if (cmd instanceof HeadObjectCommand) {
      if (!objects.has(input.Key)) throw Object.assign(new Error('missing'), { name: 'NotFound' });
      return {};
    } else throw new Error(`unexpected command ${(cmd as object).constructor.name}`);
    return {};
  }) as S3Client['send'];
  const storage = new S3Storage({ bucket: 'b', client });
  return { storage, client, objects, sent };
}

describe('s3 storage', () => {
  test('put() checks existence without needing a length on HEAD', async () => {
    const { storage, objects, sent } = fakeBackend();
    const prefix = courseObjectPrefix('00000000-0000-4000-8000-000000000001');
    const key = `${prefix}/objects/${createHash('sha256').update('hello').digest('hex')}`;

    expect(await storage.put(prefix, Buffer.from('hello'))).toMatchObject({ key, size: 5 });
    expect([...objects]).toEqual([key]);
    // Stored again: the existing object is found (HEAD without a length) and kept, not copied.
    sent.length = 0;
    expect(await storage.put(prefix, Buffer.from('hello'))).toMatchObject({ key, size: 5 });
    expect(sent.filter((s) => s.startsWith('CopyObjectCommand'))).toEqual([]);
    expect(sent).toContain(`HeadObjectCommand ${key}`);
    expect([...objects]).toEqual([key]);
  });

  test('list() pages through every object under the prefix', async () => {
    const client = new S3Client({
      endpoint: 'http://127.0.0.1:1',
      region: 'test',
      forcePathStyle: true,
      credentials: { accessKeyId: 'k', secretAccessKey: 's' },
    });
    const asked: { Prefix?: string; ContinuationToken?: string }[] = [];
    const at = new Date('2026-10-01T00:00:00Z');
    client.send = (async (cmd: unknown) => {
      if (!(cmd instanceof ListObjectsV2Command)) throw new Error('unexpected command');
      asked.push(cmd.input);
      return cmd.input.ContinuationToken
        ? { Contents: [{ Key: 'p/objects/b', LastModified: at }], IsTruncated: false }
        : {
            Contents: [{ Key: 'p/objects/a', LastModified: at }],
            IsTruncated: true,
            NextContinuationToken: 'next',
          };
    }) as S3Client['send'];
    const storage = new S3Storage({ bucket: 'b', client });
    const listed = [];
    for await (const o of storage.list('p')) listed.push(o);
    expect(listed).toEqual([
      { key: 'p/objects/a', modifiedAt: at },
      { key: 'p/objects/b', modifiedAt: at },
    ]);
    // The prefix ends at a separator, so `p` never lists the objects of `p2`.
    expect(asked.map((a) => [a.Prefix, a.ContinuationToken])).toEqual([
      ['p/', undefined],
      ['p/', 'next'],
    ]);
  });

  test('destroy() leaves an injected client open: it belongs to the caller', () => {
    const { storage, client } = fakeBackend();
    let destroyed = 0;
    client.destroy = () => {
      destroyed += 1;
    };
    storage.destroy();
    expect(destroyed).toBe(0);

    // A client built from settings is the store's own, and is released with it.
    const owned = new S3Storage({
      bucket: 'b',
      region: 'test',
      accessKeyId: 'k',
      secretAccessKey: 's',
      forcePathStyle: true,
    });
    (owned as unknown as { client: S3Client }).client.destroy = () => {
      destroyed += 1;
    };
    owned.destroy();
    expect(destroyed).toBe(1);
  });
});

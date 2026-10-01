import { createHash } from 'node:crypto';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
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
  const storage = new S3Storage({
    endpoint: 'http://127.0.0.1:1',
    region: 'test',
    bucket: 'b',
    accessKeyId: 'k',
    secretAccessKey: 's',
    forcePathStyle: true,
  });
  const client = (storage as unknown as { client: { send: (cmd: unknown) => Promise<unknown> } })
    .client;
  client.send = async (cmd: unknown) => {
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
  };
  return { storage, objects, sent };
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
});

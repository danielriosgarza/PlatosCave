import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { afterAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { mintContentToken } from '../../src/content/tokens';
import { S3Storage } from '../../src/storage/s3';
import { courseObjectPrefix, StorageNotFoundError } from '../../src/storage/storage';

/**
 * Runs against the Garage service of infra/compose.yml (profile `s3`), prepared by
 * scripts/garage-init.sh, whose output provides the S3_* variables. Skipped without them
 * locally; mandatory in CI, where the first test fails if they are missing.
 */
const env = process.env;

test.runIf(env.CI)('CI provides the Garage S3 endpoint', () => {
  expect(env.S3_ENDPOINT).toBeTruthy();
});

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

describe.skipIf(!env.S3_ENDPOINT)('s3 storage (Garage)', () => {
  const options = {
    endpoint: env.S3_ENDPOINT as string,
    region: env.S3_REGION ?? 'garage',
    bucket: env.S3_BUCKET ?? 'parallax',
    accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
    forcePathStyle: true,
  };
  const storage = new S3Storage(options);
  const course = randomUUID();
  const prefix = courseObjectPrefix(course);
  afterAll(() => storage.destroy());

  async function tmpObjects(): Promise<string[]> {
    const client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: true,
      credentials: options,
    });
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: options.bucket, Prefix: 'tmp/' }),
    );
    client.destroy();
    return (res.Contents ?? []).map((o) => o.Key as string);
  }

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

  test('multipart bodies larger than one part stream through intact', async () => {
    const part = Buffer.alloc(1024 * 1024, 7);
    const parts = Array.from({ length: 6 }, (_, i) => Buffer.concat([part, Buffer.from([i])]));
    const whole = Buffer.concat(parts);
    const stored = await storage.put(prefix, Readable.from(parts));
    expect(stored).toMatchObject({ sha256: sha(whole), size: whole.length });
    const back: Buffer[] = [];
    for await (const chunk of (await storage.get(stored.key)).body) back.push(chunk as Buffer);
    expect(sha(Buffer.concat(back))).toBe(sha(whole));
  });

  test('identical bytes share one object and leave no temporary objects', async () => {
    const a = await storage.put(prefix, Buffer.from('same'));
    const b = await storage.put(prefix, Readable.from([Buffer.from('sa'), Buffer.from('me')]));
    expect(b.key).toBe(a.key);
    expect(await tmpObjects()).toEqual([]);
  });

  test('missing objects report not found; delete is idempotent; unsafe keys are refused', async () => {
    const key = `${prefix}/objects/${sha('absent')}`;
    await expect(storage.get(key)).rejects.toBeInstanceOf(StorageNotFoundError);
    expect(await storage.head(key)).toBeNull();
    const stored = await storage.put(prefix, Buffer.from('gone'));
    await storage.delete(stored.key);
    await storage.delete(stored.key);
    expect(await storage.head(stored.key)).toBeNull();
    for (const bad of ['../etc/passwd', 'courses/../x', 'a//b', '']) {
      await expect(storage.get(bad)).rejects.toThrow(/unsafe storage key/);
    }
  });

  test('a missing bucket is a configuration error, not a missing object', async () => {
    const misconfigured = new S3Storage({ ...options, bucket: 'no-such-bucket-parallax' });
    try {
      const err = await misconfigured.get(`${prefix}/objects/${sha('x')}`).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(StorageNotFoundError);
    } finally {
      misconfigured.destroy();
    }
  });

  test('A21 the content origin streams an S3 object for a valid token only', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      APP_HOST: '127.0.0.1',
      CONTENT_HOST: 'localhost',
    });
    const app = await buildApp(config, { storage });
    try {
      const stored = await storage.put(prefix, Buffer.from('%PDF-1.7 private'));
      const { token } = mintContentToken(
        config.CONTENT_TOKEN_SECRET,
        {
          key: stored.key,
          userId: randomUUID(),
          scopeId: course,
          contentType: 'application/pdf',
          disposition: 'inline',
        },
        new Date(),
      );
      const ok = await app.inject({ url: `/content/${token}`, headers: { host: 'localhost' } });
      expect(ok.statusCode).toBe(200);
      expect(ok.body).toBe('%PDF-1.7 private');
      expect(ok.headers['content-length']).toBe('16');
      const tampered = `${token.slice(0, -4)}AAAA`;
      const denied = await app.inject({
        url: `/content/${tampered}`,
        headers: { host: 'localhost' },
      });
      expect(denied.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

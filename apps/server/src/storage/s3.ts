import { createHash, randomUUID } from 'node:crypto';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import {
  assertSafeKey,
  type Body,
  objectKey,
  type Storage,
  StorageNotFoundError,
  type StoredObject,
} from './storage';

export interface S3Options {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

const isMissing = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
};

/**
 * S3-compatible adapter (`STORAGE_DRIVER=s3`; Garage in development and CI). Same contract as
 * the fs adapter: bodies stream through in multipart chunks, never buffered whole; the object
 * lands under a temporary key while it is hashed, then is copied to its content-addressed key.
 */
export class S3Storage implements Storage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3Options) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      ...(options.endpoint && { endpoint: options.endpoint }),
    });
  }

  async put(prefix: string, body: Body): Promise<StoredObject> {
    assertSafeKey(prefix);
    const tmpKey = `tmp/${randomUUID()}`;
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        hash.update(chunk);
        size += chunk.length;
        done(null, chunk);
      },
    });
    const source = body instanceof Uint8Array ? Readable.from([body]) : Readable.from(body);
    const out = new PassThrough();
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: tmpKey, Body: out },
    });
    try {
      const uploaded = upload.done().catch((err) => {
        out.destroy(err);
        throw err;
      });
      await Promise.all([pipeline(source, meter, out), uploaded]);
      const sha256 = hash.digest('hex');
      const key = objectKey(prefix, sha256);
      // Same key means same bytes, so an existing object is kept as it is.
      if (!(await this.head(key))) {
        await this.client.send(
          new CopyObjectCommand({
            Bucket: this.bucket,
            Key: key,
            CopySource: `${this.bucket}/${tmpKey}`,
          }),
        );
      }
      return { key, sha256, size };
    } finally {
      await this.client
        .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: tmpKey }))
        .catch(() => undefined);
    }
  }

  async get(key: string): Promise<Readable> {
    assertSafeKey(key);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return res.Body as Readable;
    } catch (err) {
      if (isMissing(err)) throw new StorageNotFoundError(key);
      throw err;
    }
  }

  async head(key: string): Promise<{ size: number } | null> {
    assertSafeKey(key);
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: res.ContentLength ?? 0 };
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  destroy(): void {
    this.client.destroy();
  }
}

import { randomUUID } from 'node:crypto';
import { PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import {
  assertSafeKey,
  type Body,
  type ByteRange,
  hashingMeter,
  objectKey,
  type Storage,
  StorageNotFoundError,
  type StoredObject,
  toReadable,
} from './storage';

/** The bucket, and either a client to use (tests) or the settings to build one from. */
export type S3Options = { bucket: string } & (
  | { client: S3Client }
  | {
      endpoint?: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
    }
);

/**
 * Only a missing key counts as "not found" (GetObject: `NoSuchKey`; HeadObject has no body, so
 * its 404 is `NotFound`). Other 404s such as `NoSuchBucket` are configuration errors and throw.
 */
const isMissing = (err: unknown) => {
  const name = (err as { name?: string }).name;
  return name === 'NoSuchKey' || name === 'NotFound';
};

/**
 * S3-compatible adapter (`STORAGE_DRIVER=s3`; Garage in development and CI). Same contract as
 * the fs adapter: bodies stream through in multipart chunks, never buffered whole; the object
 * lands under a temporary key while it is hashed, then is copied to its content-addressed key.
 */
export class S3Storage implements Storage {
  private readonly client: S3Client;
  private readonly bucket: string;
  /** Only a client built here is ours to destroy; an injected one belongs to the caller. */
  private readonly ownsClient: boolean;

  constructor(options: S3Options) {
    this.bucket = options.bucket;
    this.ownsClient = !('client' in options);
    this.client =
      'client' in options
        ? options.client
        : new S3Client({
            region: options.region,
            forcePathStyle: options.forcePathStyle,
            credentials: {
              accessKeyId: options.accessKeyId,
              secretAccessKey: options.secretAccessKey,
            },
            ...(options.endpoint && { endpoint: options.endpoint }),
          });
  }

  async put(prefix: string, body: Body): Promise<StoredObject> {
    assertSafeKey(prefix);
    const tmpKey = `tmp/${randomUUID()}`;
    const { meter, result } = hashingMeter();
    const source = toReadable(body);
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
      const { sha256, size } = result();
      const key = objectKey(prefix, sha256);
      // Same key means same bytes, so an existing object is kept as it is. A single CopyObject is
      // limited to 5 GB on AWS S3 (Garage has no such limit); larger objects would need
      // UploadPartCopy.
      if (!(await this.exists(key))) {
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

  async get(key: string, range?: ByteRange): Promise<{ body: Readable; size: number }> {
    assertSafeKey(key);
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ...(range && { Range: `bytes=${range.start}-${range.end}` }),
        }),
      );
      if (res.ContentLength === undefined) {
        (res.Body as Readable).destroy();
        throw new Error(`storage object without a length: ${key}`);
      }
      // A ranged answer's length is the slice's; the whole object's is the end of ContentRange.
      const total = range ? Number(res.ContentRange?.split('/')[1]) : res.ContentLength;
      if (!Number.isInteger(total)) {
        (res.Body as Readable).destroy();
        throw new Error(`storage object without a total length: ${key}`);
      }
      return { body: res.Body as Readable, size: total };
    } catch (err) {
      if (isMissing(err)) throw new StorageNotFoundError(key);
      throw err;
    }
  }

  async head(key: string): Promise<{ size: number } | null> {
    assertSafeKey(key);
    const res = await this.headObject(key);
    if (!res) return null;
    // Same rule as get(): never report a length the backend did not give.
    if (res.ContentLength === undefined) {
      throw new Error(`storage object without a length: ${key}`);
    }
    return { size: res.ContentLength };
  }

  /** Existence only: put() must not depend on the backend reporting a length on HEAD. */
  private async exists(key: string): Promise<boolean> {
    return (await this.headObject(key)) !== null;
  }

  /** HeadObject, with a missing key as `null`; any other failure throws. */
  private async headObject(key: string): Promise<HeadObjectCommandOutput | null> {
    try {
      return await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  /** HeadBucket answers 404 for a bucket that does not exist, unlike HeadObject of a key. */
  async ping(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  destroy(): void {
    if (this.ownsClient) this.client.destroy();
  }
}

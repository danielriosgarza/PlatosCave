import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';

/** Result of storing one object: its content-addressed key, digest and byte length. */
export interface StoredObject {
  key: string;
  sha256: string;
  size: number;
}

export type Body = Readable | AsyncIterable<Uint8Array> | Uint8Array;

/**
 * Private object storage (ADR-0001/0003). Keys are content-addressed:
 * `{prefix}/objects/{sha256}`, so storing identical bytes twice yields one object.
 * Bodies stream in and out; adapters never buffer whole objects. P1-06 adds the S3 adapter.
 */
export interface Storage {
  put(prefix: string, body: Body): Promise<StoredObject>;
  /**
   * Streams an object with its byte length (one backend call); rejects with
   * `StorageNotFoundError` when it does not exist.
   */
  get(key: string): Promise<{ body: Readable; size: number }>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
  /** Releases connections the adapter holds; buildApp calls it on close. */
  destroy?(): void;
}

/** The body as a stream, whatever form it was given in. */
export const toReadable = (body: Body): Readable =>
  body instanceof Uint8Array ? Readable.from([body]) : Readable.from(body);

/** Pass-through stream that hashes and counts what flows through it, for content addressing. */
export function hashingMeter(): {
  meter: Transform;
  result: () => { sha256: string; size: number };
} {
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  });
  return { meter, result: () => ({ sha256: hash.digest('hex'), size }) };
}

export class StorageNotFoundError extends Error {
  constructor(key: string) {
    super(`storage object not found: ${key}`);
  }
}

/** Path segments of letters, digits, `_` and `-` only: no `..`, no absolute paths. */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]*(\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/;

export function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key)) throw new Error(`unsafe storage key: ${JSON.stringify(key)}`);
}

export const courseObjectPrefix = (courseId: string): string => `courses/${courseId}`;

export const objectKey = (prefix: string, sha256: string): string => `${prefix}/objects/${sha256}`;

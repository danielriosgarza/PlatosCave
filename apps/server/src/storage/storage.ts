import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';

/** Inclusive byte offsets, as in an HTTP `Range: bytes=start-end` header. */
export interface ByteRange {
  start: number;
  end: number;
}

/** Result of storing one object: its content-addressed key, digest and byte length. */
export interface StoredObject {
  key: string;
  sha256: string;
  size: number;
}

/** One stored object as `list` reports it: its key and when its bytes were last written. */
export interface ListedObject {
  key: string;
  modifiedAt: Date;
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
   * Streams an object (or only the bytes of `range`, which must lie within it) with the whole
   * object's byte length (one backend call; a ranged read by the content origin first asks
   * `head` for the size); rejects with `StorageNotFoundError` when it does
   * not exist.
   */
  get(key: string, range?: ByteRange): Promise<{ body: Readable; size: number }>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
  /**
   * Every object whose key starts with `prefix/`, in no particular order, and nothing for an
   * area that holds none. The sweep of unreferenced objects (P3-AUD10b) uses it.
   */
  list(prefix: string): AsyncIterable<ListedObject>;
  /**
   * Resolves when the store itself is usable (the bucket exists and answers, the root can be
   * written), which `head` of a missing key cannot say: a HEAD reports a missing bucket and a
   * missing key alike. Readiness uses it; absent, it falls back to `head`.
   */
  ping?(): Promise<void>;
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

/** Where a class's submitted snapshots live: inside the class's own area (ADR-0002). */
export const classSubmissionPrefix = (classId: string): string => `classes/${classId}/submissions`;

export const objectKey = (prefix: string, sha256: string): string => `${prefix}/objects/${sha256}`;

/** Where a class's notebook working-copy revisions live (P3-09). */
export const classWorkingCopyPrefix = (classId: string): string =>
  `classes/${classId}/working-copies`;

/** Where files copied out of a notebook session's workspace live (P3-09). */
/** Where a class's results exports live; retention (P4-09) finds them here. */
export const classExportPrefix = (classId: string): string => `classes/${classId}/exports`;

export const classTransferPrefix = (classId: string): string => `classes/${classId}/transfers`;

/** Live notebook outputs of one session, shown from the content origin (design §14). */
export const classLiveOutputPrefix = (classId: string, sessionId: string): string =>
  `classes/${classId}/live-outputs/${sessionId}`;

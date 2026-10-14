import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { CourseScope } from '../auth/scope';
import { convertRevision, IngestError, megabytes } from '../content/convert';
import type { Db } from '../db/client';
import {
  type DerivationSource,
  type DerivedStatus,
  DerivedStatus as DerivedStatusSchema,
  loadDerivationSource,
  readStatus,
  setDerivedStatus,
  writeDerivedOutputs,
} from '../db/jobs/derived';
import { storeCourseObject } from '../storage/objects';
import { courseObjectPrefix, type Storage, StorageNotFoundError } from '../storage/storage';
import { requeueAnnotationsMap } from './annotations-map.job';
import { defineScopedJob, sendScopedJob } from './scoped';

export const READING_INGEST = 'reading.ingest';

// The conversion is content/convert.ts (P5-09); the names it took from here are exported again.
export {
  IngestError,
  isRasterOnly,
  MAX_NATIVE_BYTES,
  MAX_NOTEBOOK_BYTES,
  MAX_PDF_BYTES,
  MAX_SLIDES,
} from '../content/convert';

/**
 * The revision types this job derives outputs for (readings, PDF decks and notebooks); it reads
 * and writes no other status.
 */
const PROCESSED_TYPES = [
  'reading_native',
  'reading_pdf',
  'slides_pdf',
  'slides_web',
  'notebook',
] as const;
export const isProcessed = (type: string): boolean =>
  (PROCESSED_TYPES as readonly string[]).includes(type);

type Revision = DerivationSource;

/**
 * Reads one object of the revision into a single unpooled buffer of its stored size, so a large
 * PDF exists once in memory and can be moved, not copied, into the parsing thread.
 */
async function readObject(
  storage: Storage | undefined,
  key: string,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!storage) throw new IngestError('This server cannot process uploaded files');
  let object: Awaited<ReturnType<Storage['get']>>;
  try {
    object = await storage.get(key);
  } catch (err) {
    if (err instanceof StorageNotFoundError) {
      throw new IngestError('The uploaded file is no longer available; upload it again');
    }
    throw err;
  }
  const { body, size } = object;
  if (size > maxBytes) {
    body.destroy();
    throw new IngestError(`The file is larger than ${megabytes(maxBytes)}`);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for await (const chunk of body) {
    const part = chunk as Uint8Array;
    if (offset + part.byteLength > size) {
      body.destroy();
      throw new Error(`Object ${key} is longer than its stored size`);
    }
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  // The store sent less than it reported (a connection dropped mid-body): not the file's fault,
  // so a plain error, which pg-boss retries, rather than ingesting or failing a truncated file.
  if (offset !== size) throw new Error(`Object ${key} ended after ${offset} of ${size} bytes`);
  return bytes;
}

/** Where a notebook's output objects are stored: the job's course and database. */
export interface ObjectStore {
  db: Db;
  scope: CourseScope;
}

/**
 * Derived outputs of one reading, deck or notebook revision (ADR-0003); `status` is written
 * separately. A notebook's images and HTML outputs are stored as objects of the course first.
 */
export async function ingestRevision(
  revision: Revision,
  storage: Storage | undefined,
  signal?: AbortSignal,
  store?: ObjectStore,
): Promise<Record<string, unknown>> {
  const read = (key: string, maxBytes: number) => readObject(storage, key, maxBytes);
  const prefix = store && courseObjectPrefix(store.scope.courseId);
  const { derived, objects } = await convertRevision(revision, { read, prefix, signal });
  if (objects.length > 0) {
    // Only a notebook has objects: it was read from storage and converted with the prefix.
    if (!storage || !store) throw new IngestError('This server cannot process uploaded files');
    for (const object of objects) {
      const stored = await storeCourseObject(
        store.db,
        storage,
        store.scope,
        object.bytes,
        object.contentType,
      );
      // The thread named each object by its bytes, as storage does; a mismatch is a bug here.
      if (stored.key !== object.key) throw new Error(`Output object stored as ${stored.key}`);
    }
  }
  return derived;
}

const status = (
  state: DerivedStatus['state'],
  jobId: string | null,
  error?: string,
): DerivedStatus => ({
  state,
  job: READING_INGEST,
  jobId,
  ...(error !== undefined && { error }),
  updatedAt: new Date().toISOString(),
});

const RETRY_LIMIT = 2;

/** The retry limit pg-boss holds for this job (workers fetch metadata); the queue default otherwise. */
const retryLimitOf = (job: object): number =>
  'retryLimit' in job && typeof job.retryLimit === 'number' ? job.retryLimit : RETRY_LIMIT;

/**
 * Renders a native reading or a notebook, or reads a PDF reading's or deck's pages, for one
 * revision of the job's course, and records progress in `derived.status`: running, then ready;
 * a failing attempt that pg-boss will retry shows queued with the error, the last one failed. Every write is guarded by the
 * job id in the status, so a superseded job (an editor sent Retry while it ran) writes nothing.
 */
const readingIngest = defineScopedJob({
  name: READING_INGEST,
  scope: { kind: 'course', role: 'editor' },
  input: z.object({ revisionId: z.uuid() }),
  queue: { retryLimit: RETRY_LIMIT, retryDelay: 30, retryBackoff: true },
  run: async ({ scope, input, db, job, storage, boss }) => {
    const revision = await loadDerivationSource(db, scope, input.revisionId);
    if (!revision) return { failed: 'revision not found in this course' };
    // Another job type's status is not this job's to write.
    if (!isProcessed(revision.type)) return { failed: 'revision has nothing to process' };

    // Once the revision's outputs are final, marks waiting on them can be placed (ADR-0003).
    // Notebooks take no anchors that need derived outputs.
    const remap = async (): Promise<object> => {
      if (!boss || revision.type === 'notebook') return {};
      try {
        return { mappingQueued: await requeueAnnotationsMap(boss, db, scope, input.revisionId) };
      } catch (err) {
        // The outputs are written either way; reprocessing would not queue it any better.
        return { mappingNotQueued: err instanceof Error ? err.message : String(err) };
      }
    };

    const mine = { jobId: job.id };
    const claimed = await setDerivedStatus(db, scope, input.revisionId, status('running', job.id), {
      ...mine,
      orUnattached: true,
    });
    if (!claimed) return { superseded: true };
    let outputs: Record<string, unknown>;
    try {
      outputs = await ingestRevision(revision, storage, job.signal, { db, scope });
    } catch (err) {
      // A stopped job writes nothing: pg-boss has settled it, or another attempt may hold it.
      if (job.signal.aborted) throw err;
      if (err instanceof IngestError) {
        const failed = status('failed', job.id, err.message);
        const written = await setDerivedStatus(db, scope, input.revisionId, failed, mine);
        return { failed: err.message, ...(written && (await remap())) };
      }
      const retrying = job.retryCount < retryLimitOf(job);
      const message = retrying
        ? `Attempt ${job.retryCount + 1} could not finish; trying again`
        : 'Processing failed. Retry the upload or contact support.';
      const next = status(retrying ? 'queued' : 'failed', job.id, message);
      const written = await setDerivedStatus(db, scope, input.revisionId, next, mine);
      if (written && !retrying) await remap();
      throw err;
    }
    const ready = status('ready', job.id);
    if (!(await writeDerivedOutputs(db, scope, input.revisionId, outputs, ready, mine))) {
      return { superseded: true };
    }
    return { revisionId: input.revisionId, state: 'ready', ...(await remap()) };
  },
});
export default readingIngest;

/** Whether a status names a job that may still be working on the revision. */
const heldByJob = (raw: unknown): boolean => {
  const parsed = DerivedStatusSchema.safeParse(raw);
  return (
    parsed.success &&
    parsed.data.jobId !== null &&
    (parsed.data.state === 'queued' || parsed.data.state === 'running')
  );
};

/**
 * Queues ingestion of one revision of the scope's course (first run or a retry), provided its
 * status is still the one the caller read (`expected`, a `statusTag`; null: none): marking it
 * queued is one guarded write, so of concurrent saves or retries of one reading, one queues.
 * Then names the new job in the status so that only it may write there. The queue is created
 * at API and worker startup (`ensureQueues`, `workScopedJob`), not on every send. Returns the
 * job id, or null when the status has changed, the revision does not exist in this course, or
 * its type is not processed.
 */
export async function enqueueReadingIngest(
  boss: PgBoss,
  db: Db,
  scope: CourseScope,
  revisionId: string,
  expected: { tag: string | null },
): Promise<string | null> {
  const previous = await readStatus(db, scope, revisionId);
  if (!previous || previous.tag !== expected.tag) return null;
  const marked = await setDerivedStatus(db, scope, revisionId, status('queued', null), {
    types: PROCESSED_TYPES,
    tag: expected.tag,
  });
  if (!marked) return null;
  let jobId: string | null;
  try {
    jobId = await sendScopedJob(boss, readingIngest, scope, { revisionId });
  } catch (err) {
    // No new job exists. A job that held the status before keeps it, so its result still
    // lands; otherwise the editor sees why nothing is queued.
    const restored = heldByJob(previous.raw)
      ? DerivedStatusSchema.parse(previous.raw)
      : status('failed', null, 'Could not queue processing');
    await setDerivedStatus(db, scope, revisionId, restored, { jobId: null });
    throw err;
  }
  // Unless the job has already started (and claimed the status itself).
  if (jobId) {
    await setDerivedStatus(db, scope, revisionId, status('queued', jobId), { jobId: null });
  }
  return jobId;
}

/** Queues ingestion for a revision no job has touched yet; a revision with a status is left as is. */
export async function enqueueIfUnprocessed(
  boss: PgBoss,
  db: Db,
  scope: CourseScope,
  revisionId: string,
): Promise<string | null> {
  return enqueueReadingIngest(boss, db, scope, revisionId, { tag: null });
}

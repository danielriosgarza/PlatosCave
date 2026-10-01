import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { CourseScope } from '../auth/scope';
import { extractPdfText } from '../content/pdf-text';
import { renderReadingInThread } from '../content/reading-render';
import { ThreadInputError } from '../content/thread';
import type { Db } from '../db/client';
import {
  type DerivationSource,
  hasDerivedStatus,
  loadDerivationSource,
  readStatus,
  setDerivedStatus,
  writeDerivedOutputs,
} from '../db/jobs/derived';
import { type Storage, StorageNotFoundError } from '../storage/storage';
import { type DerivedStatus, DerivedStatus as DerivedStatusSchema } from './derived';
import { defineScopedJob, ensureQueues, sendScopedJob } from './scoped';

export const READING_INGEST = 'reading.ingest';

/** Largest PDF the job reads into memory; P1-14 limits uploads below this. */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
/** Largest Markdown or HTML source: far more text than any reading, far less than a PDF. */
export const MAX_NATIVE_BYTES = 5 * 1024 * 1024;

/**
 * `content` of a `reading_native` revision: inline `markdown` or `html`, or an uploaded file
 * (`sourceKey` + `format`); `assets` maps image names in the source to the revision's objects.
 * `reading_pdf` names its file with `objectKey` (default: the revision's only object).
 */
const NativeContent = z.object({
  markdown: z.string().optional(),
  html: z.string().optional(),
  sourceKey: z.string().optional(),
  format: z.enum(['markdown', 'html']).optional(),
  assets: z.record(z.string(), z.string()).default({}),
});
const PdfContent = z.object({ objectKey: z.string().optional() });

/** The revision types this job derives outputs for; it reads and writes no other status. */
const READING_TYPES = ['reading_native', 'reading_pdf'] as const;
const isReading = (type: string) => (READING_TYPES as readonly string[]).includes(type);

/** A problem with the reading itself: retrying cannot help, so the job ends failed at once. */
export class IngestError extends Error {}

type Revision = DerivationSource;

const megabytes = (bytes: number) => `${bytes / (1024 * 1024)} MB`;

/**
 * Reads one object of the revision into a single unpooled buffer of its stored size, so a large
 * PDF exists once in memory and can be moved, not copied, into the parsing thread.
 */
async function readObject(
  storage: Storage | undefined,
  revision: Revision,
  key: string,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!revision.objectKeys.includes(key)) {
    throw new IngestError('The file is not part of this reading');
  }
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
  // A short read (the store reported more than it sent) is copied, so the result owns its buffer.
  return offset === size ? bytes : bytes.slice(0, offset);
}

/** Derived outputs of one reading revision (ADR-0003); `status` is written separately. */
export async function ingestRevision(
  revision: Revision,
  storage: Storage | undefined,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (revision.type === 'reading_native') {
    const content = NativeContent.safeParse(revision.content);
    if (!content.success) throw new IngestError('The reading content is not valid');
    const { markdown, html, sourceKey, format, assets } = content.data;
    for (const key of Object.values(assets)) {
      if (!revision.objectKeys.includes(key)) {
        throw new IngestError('An image is not an uploaded file of this reading');
      }
    }
    let source: string;
    let as: 'markdown' | 'html';
    if (markdown !== undefined) [source, as] = [markdown, 'markdown'];
    else if (html !== undefined) [source, as] = [html, 'html'];
    else if (sourceKey && format) {
      const bytes = await readObject(storage, revision, sourceKey, MAX_NATIVE_BYTES);
      source = new TextDecoder().decode(bytes);
      as = format;
    } else throw new IngestError('The reading has no Markdown or HTML source');
    if (Buffer.byteLength(source) > MAX_NATIVE_BYTES) {
      throw new IngestError(`The reading is larger than ${megabytes(MAX_NATIVE_BYTES)}`);
    }
    let rendered: Awaited<ReturnType<typeof renderReadingInThread>>;
    try {
      rendered = await renderReadingInThread(source, as, assets, { signal });
    } catch (err) {
      if (err instanceof ThreadInputError) throw new IngestError(err.message);
      throw err;
    }
    return {
      html: rendered.html,
      blockMap: rendered.blockMap,
      figures: rendered.figures,
      warnings: rendered.warnings,
    };
  }
  if (revision.type === 'reading_pdf') {
    const content = PdfContent.safeParse(revision.content);
    if (!content.success) throw new IngestError('The reading content is not valid');
    const key =
      content.data.objectKey ??
      (revision.objectKeys.length === 1 ? revision.objectKeys[0] : undefined);
    if (!key) throw new IngestError('The reading has no PDF file');
    const bytes = await readObject(storage, revision, key, MAX_PDF_BYTES);
    try {
      return { ...(await extractPdfText(bytes, { signal, transfer: true })) };
    } catch (err) {
      if (err instanceof ThreadInputError) throw new IngestError(err.message);
      throw err;
    }
  }
  throw new IngestError(`A ${revision.type} resource is not a reading`);
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
 * Renders a native reading or reads a PDF's pages for one revision of the job's course, and
 * records progress in `derived.status`: running, then ready; a failing attempt that pg-boss
 * will retry shows queued with the error, the last one failed. Every write is guarded by the
 * job id in the status, so a superseded job (an editor sent Retry while it ran) writes nothing.
 */
const readingIngest = defineScopedJob({
  name: READING_INGEST,
  scope: { kind: 'course', role: 'editor' },
  input: z.object({ revisionId: z.uuid() }),
  queue: { retryLimit: RETRY_LIMIT, retryDelay: 30, retryBackoff: true },
  run: async ({ scope, input, db, job, storage }) => {
    const revision = await loadDerivationSource(db, scope, input.revisionId);
    if (!revision) return { failed: 'revision not found in this course' };
    // Another job type's status (a slide deck's conversion) is not this job's to write.
    if (!isReading(revision.type)) return { failed: 'revision is not a reading' };

    const mine = { jobId: job.id };
    const claimed = await setDerivedStatus(db, scope, input.revisionId, status('running', job.id), {
      ...mine,
      orUnattached: true,
    });
    if (!claimed) return { superseded: true };
    let outputs: Record<string, unknown>;
    try {
      outputs = await ingestRevision(revision, storage, job.signal);
    } catch (err) {
      // A stopped job writes nothing: pg-boss has settled it, or another attempt may hold it.
      if (job.signal.aborted) throw err;
      if (err instanceof IngestError) {
        const failed = status('failed', job.id, err.message);
        await setDerivedStatus(db, scope, input.revisionId, failed, mine);
        return { failed: err.message };
      }
      const retrying = job.retryCount < retryLimitOf(job);
      const message = retrying
        ? `Attempt ${job.retryCount + 1} could not finish; trying again`
        : 'Processing failed. Retry the upload or contact support.';
      const next = status(retrying ? 'queued' : 'failed', job.id, message);
      await setDerivedStatus(db, scope, input.revisionId, next, mine);
      throw err;
    }
    const ready = status('ready', job.id);
    if (!(await writeDerivedOutputs(db, scope, input.revisionId, outputs, ready, mine))) {
      return { superseded: true };
    }
    return { revisionId: input.revisionId, state: 'ready' };
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
 * Queues ingestion of one revision of the scope's course (first run or a retry after failure),
 * marking it queued first so the editor sees the state at once, then naming the new job in the
 * status so that only it may write there. Creates or updates the queue first (pg-boss refuses
 * sends to a missing queue). Returns the job id, or null when the revision does not exist in
 * this course or is not a reading.
 */
export async function enqueueReadingIngest(
  boss: PgBoss,
  db: Db,
  scope: CourseScope,
  revisionId: string,
): Promise<string | null> {
  const previous = await readStatus(db, scope, revisionId);
  const marked = await setDerivedStatus(db, scope, revisionId, status('queued', null), {
    types: READING_TYPES,
  });
  if (!marked) return null;
  let jobId: string | null;
  try {
    await ensureQueues(boss, [readingIngest]);
    jobId = await sendScopedJob(boss, readingIngest, scope, { revisionId });
  } catch (err) {
    // No new job exists. A job that held the status before keeps it, so its result still
    // lands; otherwise the editor sees why nothing is queued.
    const restored = heldByJob(previous)
      ? DerivedStatusSchema.parse(previous)
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
  if (await hasDerivedStatus(db, scope, revisionId)) return null;
  return enqueueReadingIngest(boss, db, scope, revisionId);
}

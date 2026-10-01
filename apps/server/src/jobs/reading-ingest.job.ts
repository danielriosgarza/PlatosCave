import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { CourseScope } from '../auth/scope';
import { extractPdfText, PdfReadError } from '../content/pdf-text';
import { renderReading } from '../content/reading';
import type { Db } from '../db/client';
import { type Storage, StorageNotFoundError } from '../storage/storage';
import {
  type DerivationSource,
  type DerivedStatus,
  hasDerivedStatus,
  loadDerivationSource,
  setDerivedStatus,
  writeDerivedOutputs,
} from './derived';
import { defineScopedJob, sendScopedJob } from './scoped';

export const READING_INGEST = 'reading.ingest';

/** Largest upload the job reads into memory; P1-14 limits uploads below this. */
export const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

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

/** A problem with the reading itself: retrying cannot help, so the job ends failed at once. */
export class IngestError extends Error {}

type Revision = DerivationSource;

async function readObject(storage: Storage | undefined, revision: Revision, key: string) {
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
  if (size > MAX_SOURCE_BYTES) {
    body.destroy();
    throw new IngestError('The file is larger than 50 MB');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
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
      source = (await readObject(storage, revision, sourceKey)).toString('utf8');
      as = format;
    } else throw new IngestError('The reading has no Markdown or HTML source');
    const rendered = renderReading(source, as, assets);
    return {
      html: rendered.html,
      blockMap: rendered.blockMap,
      figures: rendered.figures,
      warnings: rendered.warnings,
    };
  }
  if (revision.type === 'reading_pdf') {
    const content = PdfContent.safeParse(revision.content);
    const key =
      (content.success ? content.data.objectKey : undefined) ??
      (revision.objectKeys.length === 1 ? revision.objectKeys[0] : undefined);
    if (!key) throw new IngestError('The reading has no PDF file');
    const bytes = await readObject(storage, revision, key);
    try {
      return { ...(await extractPdfText(new Uint8Array(bytes), { signal })) };
    } catch (err) {
      if (err instanceof PdfReadError) throw new IngestError(err.message);
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
 * will retry shows queued with the error, the last one failed.
 */
const readingIngest = defineScopedJob({
  name: READING_INGEST,
  scope: { kind: 'course', role: 'editor' },
  input: z.object({ revisionId: z.uuid() }),
  queue: { retryLimit: RETRY_LIMIT, retryDelay: 30, retryBackoff: true },
  run: async ({ scope, input, db, job, storage }) => {
    const revision = await loadDerivationSource(db, scope, input.revisionId);
    if (!revision) return { failed: 'revision not found in this course' };

    await setDerivedStatus(db, scope, input.revisionId, status('running', job.id));
    let outputs: Record<string, unknown>;
    try {
      outputs = await ingestRevision(revision, storage, job.signal);
    } catch (err) {
      if (err instanceof IngestError) {
        await setDerivedStatus(db, scope, input.revisionId, status('failed', job.id, err.message));
        return { failed: err.message };
      }
      const retrying = job.retryCount < retryLimitOf(job);
      const message = retrying
        ? `Attempt ${job.retryCount + 1} could not finish; trying again`
        : 'Processing failed. Retry the upload or contact support.';
      await setDerivedStatus(
        db,
        scope,
        input.revisionId,
        status(retrying ? 'queued' : 'failed', job.id, message),
      );
      throw err;
    }
    await writeDerivedOutputs(db, scope, input.revisionId, outputs, status('ready', job.id));
    return { revisionId: input.revisionId, state: 'ready' };
  },
});
export default readingIngest;

/**
 * Creates the queue once per pg-boss instance (per process, not per upload) and applies the
 * current options to it: `createQueue` leaves an existing queue's options unchanged.
 */
const queues = new WeakMap<PgBoss, Promise<void>>();
function ensureQueue(boss: PgBoss): Promise<void> {
  let created = queues.get(boss);
  if (!created) {
    const { name, queue } = readingIngest;
    created = boss.createQueue(name, queue).then(() => boss.updateQueue(name, queue));
    queues.set(boss, created);
    created.catch(() => queues.delete(boss));
  }
  return created;
}

/**
 * Queues ingestion of one revision of the scope's course (first run or a retry after failure),
 * marking it queued first so the editor sees the state at once. Creates the queue if no worker
 * has yet (pg-boss refuses sends to a missing queue). Returns the job id, or null when the
 * revision does not exist in this course.
 */
export async function enqueueReadingIngest(
  boss: PgBoss,
  db: Db,
  scope: CourseScope,
  revisionId: string,
): Promise<string | null> {
  if (!(await setDerivedStatus(db, scope, revisionId, status('queued', null)))) return null;
  try {
    await ensureQueue(boss);
    return await sendScopedJob(boss, readingIngest, scope, { revisionId });
  } catch (err) {
    await setDerivedStatus(
      db,
      scope,
      revisionId,
      status('failed', null, 'Could not queue processing'),
    );
    throw err;
  }
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

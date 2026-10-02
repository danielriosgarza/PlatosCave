import { basename } from 'node:path';
import multipart from '@fastify/multipart';
import {
  getCourseOverview,
  getProcessing,
  MAX_UPLOAD_BYTES,
  retryProcessing,
  type UploadFormat,
  uploadCourseFile,
  uploadFormats,
} from '@parallax/contracts/routes/authoring';
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../app';
import { courseOverview } from '../../db/courseOverview';
import { listResourceJobStatus } from '../../db/jobs/derived';
import type { ResourceJobStatus } from '../../jobs/derived';
import { enqueueReadingIngest, isProcessed } from '../../jobs/reading-ingest.job';
import { storeCourseObject } from '../../storage/objects';
import { notFound, refuse, registerRoute } from '../register';

const contentTypes: Record<UploadFormat, string> = {
  markdown: 'text/markdown',
  html: 'text/html',
  pdf: 'application/pdf',
};

/** A problem with the uploaded file itself, reported to the editor as a 400. */
class UploadRejected extends Error {}

/** The file went over the size limit, reported as a 413. */
class UploadTooLarge extends Error {}

const entry = (r: ResourceJobStatus) => ({
  resourceId: r.resourceId,
  topicId: r.topicId,
  title: r.title,
  revisionId: r.revisionId,
  state: r.status?.state ?? null,
  error: r.status?.error ?? null,
  updatedAt: r.status?.updatedAt ?? null,
});

const PDF_MAGIC = '%PDF-';

/** Passes the file through, refusing bytes that are not what its extension claims. */
async function* checked(
  stream: AsyncIterable<Buffer> & { truncated?: boolean },
  format: UploadFormat,
) {
  const decoder = format === 'pdf' ? undefined : new TextDecoder('utf-8', { fatal: true });
  let empty = true;
  let header = Buffer.alloc(0);
  try {
    for await (const chunk of stream) {
      if (format === 'pdf' && header.length < PDF_MAGIC.length) {
        // A slow client may deliver the first bytes in pieces; judge the first five together.
        header = Buffer.concat([header, chunk]).subarray(0, PDF_MAGIC.length);
        if (!PDF_MAGIC.startsWith(header.toString('latin1').slice(0, header.length))) {
          throw new UploadRejected('The file is not a PDF');
        }
      }
      if (decoder && chunk.includes(0)) throw new UploadRejected('The file is not text');
      decoder?.decode(chunk, { stream: true });
      empty = false;
      yield chunk;
    }
    // The parser stops at the limit without an error; refusing here keeps the object unstored.
    if (stream.truncated) throw new UploadTooLarge();
    if (format === 'pdf' && !empty && header.toString('latin1') !== PDF_MAGIC) {
      throw new UploadRejected('The file is not a PDF');
    }
    decoder?.decode();
  } catch (err) {
    if (err instanceof TypeError) throw new UploadRejected('The text is not valid UTF-8');
    throw err;
  }
  if (empty) throw new UploadRejected('The file is empty');
}

/** The file name as shown back to the editor: no directories, no control characters. */
const displayName = (name: string) =>
  [...basename(name.replaceAll('\\', '/'))]
    .filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127)
    .join('')
    .slice(0, 200);

export default function authoringRoutes(app: FastifyInstance, deps: Deps): void {
  const db = () => {
    if (!deps.db) throw app.httpErrors.serviceUnavailable();
    return deps.db;
  };
  // Scoped to this module: the parser only exists on the routes that take uploads.
  app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2, parts: 3 },
  });

  registerRoute(app, getCourseOverview, async ({ scope }) => {
    return (await courseOverview(db(), scope)) ?? notFound();
  });

  registerRoute(app, uploadCourseFile, async ({ scope, req }) => {
    if (!req.isMultipart()) refuse(400, 'send the file as multipart/form-data');
    const part = await req.file();
    if (part?.fieldname !== 'file') refuse(400, 'the request has no file part');
    if (!part.filename) refuse(400, 'the file part has no file name');
    const filename = displayName(part.filename);
    const dot = filename.lastIndexOf('.');
    const extension = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : undefined;
    // Own keys only: `constructor` and the like are not extensions.
    const format =
      extension && Object.hasOwn(uploadFormats, extension)
        ? uploadFormats[extension as keyof typeof uploadFormats]
        : undefined;
    if (!format) refuse(400, 'Upload a Markdown (.md), HTML (.html) or PDF (.pdf) file');
    try {
      const stored = await storeCourseObject(
        db(),
        app.contentDeps.storage,
        scope,
        checked(part.file, format),
        contentTypes[format],
      );
      return { key: stored.key, sha256: stored.sha256, size: stored.size, format, filename };
    } catch (err) {
      if (err instanceof UploadRejected) refuse(400, err.message);
      if (err instanceof UploadTooLarge) {
        throw app.httpErrors.payloadTooLarge(
          `The file is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`,
        );
      }
      throw err;
    }
  });

  registerRoute(app, getProcessing, async ({ scope }) => ({
    resources: (await listResourceJobStatus(db(), scope)).map(entry),
  }));

  registerRoute(app, retryProcessing, async ({ scope, params }) => {
    const [found] = await listResourceJobStatus(db(), scope, params.resourceId);
    if (!found?.revisionId || !isProcessed(found.type)) {
      notFound();
    }
    // Only a failed or never-queued reading is queued again: a running job would race the new one.
    if (found.status && found.status.state !== 'failed') {
      refuse(409, 'This resource is already queued, being processed or ready');
    }
    if (!deps.boss) throw app.httpErrors.serviceUnavailable();
    await enqueueReadingIngest(deps.boss, db(), scope, found.revisionId);
    const [now] = await listResourceJobStatus(db(), scope, params.resourceId);
    return entry(now ?? found);
  });
}

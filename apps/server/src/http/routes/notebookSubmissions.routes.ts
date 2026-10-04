import { finished, type Readable } from 'node:stream';
import multipart from '@fastify/multipart';
import {
  getSubmissionDownload,
  launchColab,
  listOwnSubmissions,
  MAX_SUBMISSION_BYTES,
  reviewSubmissions,
  submitNotebook,
} from '@parallax/contracts/routes/notebookSubmissions';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { RouteDeps } from '../../app';
import { downloadName, mintContentUrl } from '../../content/media';
import {
  checkedNotebook,
  notebookEnvironment,
  SubmissionRejected,
  SubmissionTooLarge,
  submissionFilename,
} from '../../content/submission';
import * as submissions from '../../db/notebookSubmissions';
import type { Outcome } from '../../outcome';
import { classSubmissionPrefix } from '../../storage/storage';
import { notFound, registerRoute, settle } from '../register';

const NOTEBOOK_TYPE = 'application/x-ipynb+json';

/** Reads a stream to its end, discarding the bytes; stops quietly if it fails or is destroyed. */
async function drain(stream: Readable): Promise<void> {
  if (stream.destroyed || stream.readableEnded) return;
  await new Promise<void>((resolve) => {
    finished(stream, () => resolve());
    stream.resume();
  });
}

export default function notebookSubmissionRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const db = () => {
    if (!deps.db) throw app.httpErrors.serviceUnavailable();
    return deps.db;
  };
  const now = () => app.resolverDeps.now();
  // Scoped to this module: the parser only exists on the route that takes the upload.
  app.register(multipart, {
    limits: { fileSize: MAX_SUBMISSION_BYTES, files: 1, fields: 1, parts: 2 },
  });

  registerRoute(app, launchColab, async ({ scope, params }) =>
    settle(await submissions.recordColabLaunch(db(), scope, params.resourceId, now())),
  );

  registerRoute(app, submitNotebook, async ({ scope, params, query, req, fail }) => {
    const invalid: (message: string) => never = (message) =>
      fail(400, { error: 'invalid', message });
    // Before anything is stored: a notebook the caller may not submit to, or an archived class,
    // refuses without keeping the bytes.
    const found = await submissions.submittableNotebook(db(), scope, params.resourceId, now());
    settle(found);
    if (!req.isMultipart()) invalid('send the file as multipart/form-data');
    const part = await req.file();
    if (part?.fieldname !== 'file') invalid('the request has no file part');
    const filename = submissionFilename(part.filename ?? '');
    if (!filename.toLowerCase().endsWith('.ipynb')) {
      await drain(part.file);
      invalid('Upload a Jupyter notebook (.ipynb) file');
    }
    let environment: Record<string, string | number> = {};
    let outcome: Outcome<z.input<typeof submitNotebook.response>>;
    try {
      const stored = await deps.storage.put(
        classSubmissionPrefix(scope.classId),
        checkedNotebook(part.file, (notebook) => {
          environment = notebookEnvironment(notebook);
        }),
      );
      outcome = await submissions.recordSubmission(
        db(),
        scope,
        params.resourceId,
        { submissionKey: query.submissionKey, filename, stored, environment },
        now(),
      );
    } catch (err) {
      // Read the rest of a refused file before answering: unread, it holds the connection open.
      await drain(part.file);
      if (err instanceof SubmissionRejected) invalid(err.message);
      if (err instanceof SubmissionTooLarge) {
        throw app.httpErrors.payloadTooLarge(
          `The file is larger than ${MAX_SUBMISSION_BYTES / (1024 * 1024)} MB`,
        );
      }
      throw err;
    }
    return settle(outcome);
  });

  registerRoute(app, listOwnSubmissions, async ({ scope, params }) => ({
    submissions: await submissions.listOwnSubmissions(db(), scope, params.resourceId),
  }));

  registerRoute(app, reviewSubmissions, async ({ scope, params }) => ({
    submissions: await submissions.reviewSubmissions(db(), scope, params.resourceId),
  }));

  registerRoute(app, getSubmissionDownload, async ({ scope, params }) => {
    const object = await submissions.submissionObject(db(), scope, params.submissionId);
    if (!object) notFound();
    return mintContentUrl(
      {
        contentOrigin: deps.config.CONTENT_ORIGIN,
        secret: deps.config.CONTENT_TOKEN_SECRET,
        now: now(),
      },
      scope,
      { key: object.key, contentType: NOTEBOOK_TYPE },
      { disposition: 'attachment', filename: downloadName(object.filename, NOTEBOOK_TYPE) },
    );
  });
}

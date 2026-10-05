import { parseNotebook } from '@parallax/contracts';
import {
  getTransfer,
  getTransferDownload,
  listTransfers,
} from '@parallax/contracts/routes/transfers';
import {
  getWorkingCopy,
  MAX_WORKING_COPY_BYTES,
  saveWorkingCopy,
  submitWorkingCopy,
} from '@parallax/contracts/routes/workingCopies';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import { downloadName, mintContentUrl } from '../../content/media';
import { notebookEnvironment, submissionFilename } from '../../content/submission';
import {
  NOTEBOOK_TYPE,
  revisionBytes,
  storeNotebook,
  workingCopyView,
} from '../../content/workingCopy';
import * as submissions from '../../db/notebookSubmissions';
import { findSession } from '../../db/notebooks/sessions';
import { findTransfer, sessionTransfers, submittableTransfers } from '../../db/notebooks/transfers';
import {
  appendRevision,
  findWorkingCopy,
  notebookResource,
  workingCopyById,
} from '../../db/notebooks/workingCopies';
import { transferView } from '../../relay/transfers';
import { classSubmissionPrefix } from '../../storage/storage';
import { notFound, registerRoute, settle } from '../register';

/** A save carries the notebook as JSON inside `{ baseRevision, notebook }`. */
const SAVE_BODY_LIMIT = MAX_WORKING_COPY_BYTES + 64 * 1024;

/**
 * Working copies (spec §10.5, docs/design/connector.md §11): read, save with a base revision,
 * and Submit notebook; and the transfer records of a session, which need no live link. Every
 * route reads the caller's own records through their class scope: anyone else's is the shared
 * 404. Nothing here sends anything to a connector.
 */
export default function workingCopyRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const db = deps.requireDb;
  const { now, storage } = deps;

  registerRoute(app, getWorkingCopy, async ({ scope, params, query }) => {
    const copy = await findWorkingCopy(db(), scope, params.revisionId);
    if (!copy) return notFound();
    const view = await workingCopyView(db(), storage, scope, copy, query.revision);
    return view ?? notFound();
  });

  registerRoute(
    app,
    saveWorkingCopy,
    async ({ scope, params, body, fail }) => {
      const copy = await workingCopyById(db(), scope, params.workingCopyId);
      if (!copy) return notFound();
      if (scope.archived) return fail(409, { error: 'class_archived' });
      // Validated and stored before the revision number is taken; a refused save stores a
      // content-addressed object nothing names, which costs nothing to keep.
      const stored = await storeNotebook(storage, scope, JSON.stringify(body.notebook));
      if (!stored.ok) {
        if (stored.tooLarge) return fail(413, { error: 'too_large', message: stored.error });
        return fail(400, { error: 'invalid', message: stored.error });
      }
      const appended = await appendRevision(
        db(),
        scope,
        copy.id,
        { baseRevision: body.baseRevision, stored: stored.stored, source: 'browser' },
        now(),
      );
      if (!appended.ok) {
        if (appended.reason !== 'revision_conflict') {
          return appended.reason === 'not_found'
            ? notFound()
            : fail(409, { error: 'class_archived' });
        }
        const current = await workingCopyView(db(), storage, scope, appended.workingCopy);
        if (!current) throw new Error('the current working-copy revision is missing');
        return fail(409, { error: 'revision_conflict', current });
      }
      const view = await workingCopyView(db(), storage, scope, appended.workingCopy);
      if (!view) throw new Error('the saved working-copy revision is missing');
      return view;
    },
    { bodyLimit: SAVE_BODY_LIMIT },
  );

  registerRoute(app, submitWorkingCopy, async ({ scope, params, body, fail }) => {
    const invalid = (message: string) => fail(400, { error: 'invalid', message });
    const copy = await workingCopyById(db(), scope, params.workingCopyId);
    if (!copy) return notFound();
    const resource = await notebookResource(db(), scope, copy.sourceRevisionId);
    if (!resource) return notFound();
    const session = await findSession(db(), scope, body.sessionId);
    if (session?.resourceRevisionId !== copy.sourceRevisionId) {
      return invalid('That session did not open this notebook');
    }
    const found = await revisionBytes(db(), storage, scope, copy, body.revision);
    if (!found) return invalid('That revision of the notebook was not saved to Parallax');
    const ids = [...new Set(body.transferIds)];
    const transfers = await submittableTransfers(db(), scope, copy.sourceRevisionId, ids);
    if (transfers.length !== ids.length) {
      return invalid(
        'Only files copied to Parallax from this notebook’s sessions can be submitted',
      );
    }
    const paths = new Set(transfers.map((t) => t.path));
    if (paths.size !== transfers.length) return invalid('Two selected files have the same path');
    const parsed = parseNotebook(found.bytes.toString('utf8'));
    if (!parsed.ok) throw new Error('a stored working-copy revision is not a valid notebook');
    const { runtime: _declaredRuntime, ...declared } = notebookEnvironment(parsed.notebook);
    const reported = session.environment ?? {};
    const environment: Record<string, string> = {
      ...Object.fromEntries(Object.entries(declared).map(([key, value]) => [key, String(value)])),
      runtime: 'connector',
      ...(reported.os && { os: reported.os }),
      ...(reported.arch && { arch: reported.arch }),
      ...(reported.runtime && { interpreter: reported.runtime }),
      ...(session.jupyterVersion && { jupyter: session.jupyterVersion }),
    };
    // Frozen apart from the working copy, under the class's submissions.
    const stored = await storage.put(classSubmissionPrefix(scope.classId), found.bytes);
    return settle(
      await submissions.recordSubmission(
        db(),
        scope,
        resource.resourceId,
        {
          submissionKey: body.submissionKey,
          filename: submissionFilename(downloadName(resource.title ?? 'notebook', NOTEBOOK_TYPE)),
          stored,
          environment,
          connected: {
            workingCopyId: copy.id,
            workingCopyRevision: found.row.revision,
            sourceRevisionId: copy.sourceRevisionId,
            sessionId: session.id,
            files: transfers.map((t) => ({
              transferId: t.id,
              path: t.path,
              sha256: t.sha256,
              size: t.size,
              objectKey: t.objectKey as string,
            })),
          },
        },
        now(),
      ),
    );
  });

  registerRoute(app, listTransfers, async ({ scope, params }) => {
    const session = await findSession(db(), scope, params.sessionId);
    if (!session) return notFound();
    return { transfers: (await sessionTransfers(db(), scope, session)).map(transferView) };
  });

  registerRoute(app, getTransfer, async ({ scope, params }) => {
    const session = await findSession(db(), scope, params.sessionId);
    if (!session) return notFound();
    const row = await findTransfer(db(), scope, session, params.transferId);
    return row ? transferView(row) : notFound();
  });

  registerRoute(app, getTransferDownload, async ({ scope, params }) => {
    const session = await findSession(db(), scope, params.sessionId);
    if (!session) return notFound();
    const row = await findTransfer(db(), scope, session, params.transferId);
    if (!row?.objectKey) return notFound();
    return mintContentUrl(
      {
        contentOrigin: deps.config.CONTENT_ORIGIN,
        secret: deps.config.CONTENT_TOKEN_SECRET,
        now: now(),
      },
      scope,
      { key: row.objectKey, contentType: 'application/octet-stream' },
      { disposition: 'attachment', filename: submissionFilename(row.path) || 'file' },
    );
  });
}

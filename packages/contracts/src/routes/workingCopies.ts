import { z } from 'zod';
import { classArchived, defineRoute, errorBody, invalidBody } from '../define';
import { exampleIds } from '../examples';
import { submissionReceipt } from './notebookSubmissions';

/**
 * Working copies of course notebooks (spec §10.5, docs/design/connector.md §11). The course
 * notebook is immutable; the first Connect for a person, class and notebook revision creates
 * that person's working copy, whose revision 1 is the course notebook. Parallax stores the
 * revisions the browser saved and acknowledged; it never stores kernel memory, and a save never
 * claims that a file on the connected computer was written. Every route reads only the caller's
 * own working copies: anyone else's, the class instructor's included, is the shared 404.
 */

/** Largest notebook revision Parallax stores, with its saved outputs (as a submission). */
export const MAX_WORKING_COPY_BYTES = 25 * 1024 * 1024;

const datetime = z.iso.datetime({ offset: true });

/** Where a revision came from: a browser save, an import from the workspace, or the course. */
export const WorkingCopySource = z.enum(['browser', 'import', 'server']);

/** One acknowledged revision: stored by Parallax, so **Saved to Parallax** may say so. */
export const WorkingCopyRevisionView = z.object({
  revision: z.int().min(1),
  sha256: z.string(),
  size: z.int(),
  source: WorkingCopySource,
  savedAt: datetime,
});

/** A nbformat 4 notebook as JSON; checked against the nbformat schema on the server. */
export const NotebookJson = z.record(z.string(), z.unknown());

export const WorkingCopyView = z.object({
  id: z.uuid(),
  /** The course notebook revision this copy was made from. */
  sourceRevisionId: z.uuid(),
  currentRevision: z.int().min(1),
  /** The revision returned in `notebook`: the current one unless another was asked for. */
  revision: WorkingCopyRevisionView,
  notebook: NotebookJson,
  /** Every acknowledged revision, newest first (at most 100). */
  revisions: z.array(WorkingCopyRevisionView),
});
export type WorkingCopyView = z.infer<typeof WorkingCopyView>;

/**
 * The caller's working copy of a course notebook revision, with the current revision's notebook
 * (or `?revision=`). 404 before the first Connect made one, or for a revision that does not exist.
 */
export const getWorkingCopy = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/notebook-working-copies/:revisionId',
  scope: { kind: 'class', role: 'any' },
  summary: 'Read your working copy of a notebook',
  params: z.object({ classId: z.uuid(), revisionId: z.uuid() }),
  query: z.object({ revision: z.coerce.number().int().min(1).optional() }),
  response: WorkingCopyView,
  examples: { params: { classId: exampleIds.zero, revisionId: exampleIds.bb }, query: {} },
});

/**
 * Saves the next revision (ADR-0003 optimistic concurrency): `baseRevision` is the revision the
 * browser edited. A stale base is `409 revision_conflict` carrying the current copy; nothing is
 * overwritten. The answer is the acknowledgement **Saved to Parallax** waits for; it says nothing
 * about files on the connected computer. 400 for a notebook that is not valid nbformat 4; 413
 * over MAX_WORKING_COPY_BYTES.
 */
export const saveWorkingCopy = defineRoute({
  method: 'PUT',
  path: '/api/classes/:classId/notebook-working-copies/:workingCopyId/revisions',
  scope: { kind: 'class', role: 'any' },
  summary: 'Save a new revision of your working copy',
  params: z.object({ classId: z.uuid(), workingCopyId: z.uuid() }),
  body: z.strictObject({ baseRevision: z.int().min(1), notebook: NotebookJson }),
  response: WorkingCopyView,
  errors: {
    400: invalidBody,
    409: z.union([
      z.object({ error: z.literal('revision_conflict'), current: WorkingCopyView }),
      classArchived,
    ]),
    413: errorBody,
  },
  examples: {
    params: { classId: exampleIds.zero, workingCopyId: exampleIds.aa },
    body: {
      baseRevision: 1,
      notebook: { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] },
    },
  },
});

const submissionKey = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * **Submit notebook** (§10.5, design §11): freezes an acknowledged revision of the working copy,
 * the selected copied-out files that are `done`, and the environment the session reported, as the
 * next version of the caller's submission through the notebook-submission service. Reads only
 * what Parallax already holds: nothing is asked of the connector. `submissionKey` makes it
 * idempotent. 400 names a transfer that is not a finished copy-out of this notebook, or a
 * revision that does not exist; 409 `class_archived`.
 */
export const submitWorkingCopy = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/notebook-working-copies/:workingCopyId/submit',
  scope: { kind: 'class', role: 'any' },
  summary: 'Submit a revision of your working copy with selected copied files',
  params: z.object({ classId: z.uuid(), workingCopyId: z.uuid() }),
  body: z.strictObject({
    revision: z.int().min(1),
    /** The session whose environment is recorded; one of the caller's on this notebook. */
    sessionId: z.uuid(),
    /** Copied-out files to include; each must be `done`. */
    transferIds: z.array(z.uuid()).max(50).default([]),
    submissionKey,
  }),
  response: submissionReceipt,
  errors: { 400: invalidBody, 409: classArchived },
  examples: {
    params: { classId: exampleIds.zero, workingCopyId: exampleIds.aa },
    body: { revision: 1, sessionId: exampleIds.cc, submissionKey: 'example-key-0001' },
  },
});

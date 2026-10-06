import { z } from 'zod';
import { classArchived, defineRoute, errorBody, invalidBody } from '../define';
import { exampleIds } from '../examples';

/**
 * The Colab route and notebook submissions (§10.1, §10.5, §10.7). Opening Colab is an explicit
 * external launch that creates no grade and no runtime sync; the way back is an uploaded `.ipynb`.
 * A submission freezes the uploaded file after the upload was acknowledged, pinned to the notebook
 * revision the class studied. Resubmitting adds the next version; earlier versions stay.
 */

/** Where Colab is opened; the working copy is made there with the steps the tab lists. */
export const COLAB_URL = 'https://colab.research.google.com/';

/** Largest notebook a submission accepts, with its saved outputs. */
export const MAX_SUBMISSION_BYTES = 25 * 1024 * 1024;

const exampleClass = exampleIds.zero;
const exampleResource = exampleIds.bb;
const exampleSubmission = exampleIds.ee;

const timestamp = z.iso.datetime({ offset: true });
const resourceParams = z.object({ classId: z.uuid(), resourceId: z.uuid() });

/**
 * What the submitted file says about where it was made (`runtime`, `kernel`, `language`,
 * `languageVersion`, `nbformat`). The file declares it; it is not a verified fact about the
 * machine (§10.5).
 */
export const submissionEnvironment = z.record(z.string(), z.union([z.string(), z.number()]));

/** A copied-out file frozen with a submission from a connected session (P3-09). */
export const submissionFile = z.object({
  /** The copy-out it came from; its download is `…/notebook-submissions/:id/files/:fileId`. */
  id: z.uuid(),
  /** Where the file was in the workspace. */
  path: z.string(),
  size: z.int(),
  sha256: z.string(),
});

/** The receipt of one acknowledged submission. */
export const submissionReceipt = z.object({
  id: z.uuid(),
  resourceId: z.uuid(),
  /** The notebook revision the class studied when the file was handed in. */
  resourceRevisionId: z.uuid(),
  /** 1 for the first submission of this notebook, then one more each time. */
  version: z.int(),
  filename: z.string(),
  size: z.int(),
  sha256: z.string(),
  environment: submissionEnvironment,
  receivedAt: timestamp,
  /**
   * A submission from a connected session (P3-09): the working-copy revision it froze and the
   * selected files copied out of the workspace. Absent for an uploaded file.
   */
  workingCopyRevision: z.int().optional(),
  files: z.array(submissionFile).optional(),
});

export const reviewedSubmission = submissionReceipt.extend({
  student: z.object({ id: z.uuid(), name: z.string() }),
  /** The student has since been removed from the class; the work stays reviewable. */
  removed: z.boolean(),
});

/** Records that the caller opened Colab for this notebook; creates nothing else. */
export const launchColab = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/resources/:resourceId/colab-launch',
  scope: { kind: 'class', role: 'any' },
  allowWhenArchived: true,
  summary: 'Record an Open in Colab launch of a notebook; no grade, no runtime sync',
  params: resourceParams,
  /** Null when nothing was recorded (a preview records nothing). */
  response: z.object({ launchedAt: timestamp.nullable() }),
  errors: { 409: classArchived },
  examples: { params: { classId: exampleClass, resourceId: exampleResource } },
});

const submissionKey = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * Multipart body with one `file` part: a Jupyter `.ipynb` of at most MAX_SUBMISSION_BYTES.
 * `submissionKey` makes the request idempotent: the same key answers the same receipt and adds no
 * version. 400 names the problem for another file type, an empty file, text that is not valid
 * UTF-8 or a notebook that is not valid nbformat 4 (§10.7); 413 for a file over the limit; 409
 * `class_archived` once the class is archived. The notebook is never run.
 */
export const submitNotebook = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/resources/:resourceId/notebook-submissions',
  scope: { kind: 'class', role: 'any' },
  summary: 'Submit a notebook file as the next version of your submission',
  params: resourceParams,
  query: z.object({ submissionKey }),
  response: submissionReceipt,
  errors: { 400: invalidBody, 409: classArchived, 413: errorBody },
  examples: {
    params: { classId: exampleClass, resourceId: exampleResource },
    query: { submissionKey: 'example-key-0001' },
  },
});

export const listOwnSubmissions = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/resources/:resourceId/notebook-submissions/mine',
  scope: { kind: 'class', role: 'any' },
  summary: 'Your submissions of a notebook, newest version first',
  params: resourceParams,
  response: z.object({ submissions: z.array(submissionReceipt) }),
  examples: { params: { classId: exampleClass, resourceId: exampleResource } },
});

export const reviewSubmissions = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/resources/:resourceId/notebook-submissions',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'Every student’s submissions of a notebook, by student and newest version first',
  params: resourceParams,
  response: z.object({ submissions: z.array(reviewedSubmission) }),
  examples: { params: { classId: exampleClass, resourceId: exampleResource } },
});

/** A short-lived download link on the content origin: the student's own file, or any student's for an instructor. */
export const getSubmissionDownload = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/notebook-submissions/:submissionId/download',
  scope: { kind: 'class', role: 'any' },
  summary: 'A link to download one submitted snapshot',
  params: z.object({ classId: z.uuid(), submissionId: z.uuid() }),
  response: z.object({ url: z.string(), expiresAt: timestamp }),
  examples: { params: { classId: exampleClass, submissionId: exampleSubmission } },
});

/**
 * A link to download one file frozen with a submission from a connected session: the student's
 * own, or any student's for an instructor. Served as an attachment from the content origin;
 * nothing is asked of the student's computer (A35).
 */
export const getSubmissionFileDownload = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/notebook-submissions/:submissionId/files/:fileId/download',
  scope: { kind: 'class', role: 'any' },
  summary: 'A link to download one file of a submitted snapshot',
  params: z.object({ classId: z.uuid(), submissionId: z.uuid(), fileId: z.uuid() }),
  response: z.object({ url: z.string(), expiresAt: timestamp }),
  examples: {
    params: { classId: exampleClass, submissionId: exampleSubmission, fileId: exampleIds.dd },
  },
});

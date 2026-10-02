import { z } from 'zod';
import { defineRoute } from '../define';

/** Authoring support around drafts: uploads, processing status and the course overview (§12). */

const exampleCourseId = '00000000-0000-4000-8000-000000000000';
const exampleResourceId = '00000000-0000-4000-8000-0000000000bb';
const courseParams = z.object({ courseId: z.uuid() });
const timestamp = z.iso.datetime({ offset: true });

/** Largest reading upload; the ingestion job refuses anything over 50 MiB regardless. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Reading formats an editor may upload, by file extension. */
export const uploadFormats = {
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  pdf: 'pdf',
} as const;
export type UploadFormat = (typeof uploadFormats)[keyof typeof uploadFormats];

export const uploadedFile = z.object({
  /** Content-addressed storage key, `courses/{courseId}/objects/{sha256}`; what a revision lists. */
  key: z.string(),
  sha256: z.string(),
  size: z.int(),
  format: z.enum(['markdown', 'html', 'pdf']),
  filename: z.string(),
});

/**
 * Multipart body with one `file` part (Markdown, HTML or PDF, up to MAX_UPLOAD_BYTES). The scope
 * is resolved before the body is read, so a non-member never reaches the parser. 400 names the
 * problem for an unsupported type, an empty or oversized file, or text that is not valid UTF-8;
 * 413 for a file over the limit.
 */
export const uploadCourseFile = defineRoute({
  method: 'POST',
  path: '/api/courses/:courseId/uploads',
  scope: { kind: 'course', role: 'editor' },
  summary: 'Store a reading file in the course’s content-addressed storage',
  params: courseParams,
  response: uploadedFile,
  examples: { params: { courseId: exampleCourseId } },
});

export const processingState = z.enum(['queued', 'running', 'ready', 'failed']);

export const processingEntry = z.object({
  resourceId: z.uuid(),
  topicId: z.uuid(),
  title: z.string(),
  revisionId: z.uuid().nullable(),
  /** Null when the head revision has nothing to process. */
  state: processingState.nullable(),
  error: z.string().nullable(),
  updatedAt: timestamp.nullable(),
});

export const getProcessing = defineRoute({
  method: 'GET',
  path: '/api/courses/:courseId/processing',
  scope: { kind: 'course', role: 'editor' },
  summary: 'Processing state of each draft resource’s head revision',
  params: courseParams,
  response: z.object({ resources: z.array(processingEntry) }),
  examples: { params: { courseId: exampleCourseId } },
});

/**
 * 404 when the resource is not a reading or PDF deck, or has no revision to process; 409 unless
 * its job failed, was never queued, or stopped without finishing (shown as failed by
 * `getProcessing`).
 */
export const retryProcessing = defineRoute({
  method: 'POST',
  path: '/api/courses/:courseId/resources/:resourceId/processing',
  scope: { kind: 'course', role: 'editor' },
  summary: 'Queue processing of a reading’s or PDF deck’s head revision again',
  params: courseParams.extend({ resourceId: z.uuid() }),
  response: processingEntry,
  examples: { params: { courseId: exampleCourseId, resourceId: exampleResourceId } },
});

const releaseRef = z.object({ id: z.uuid(), version: z.int() });

/** The course as its editors see it: which class runs which release (§12 “Class A uses …”). */
export const getCourseOverview = defineRoute({
  method: 'GET',
  path: '/api/courses/:courseId/overview',
  scope: { kind: 'course', role: 'editor' },
  summary: 'Course title, its releases and the release each class currently uses',
  params: courseParams,
  response: z.object({
    id: z.uuid(),
    title: z.string(),
    latestRelease: releaseRef.extend({ createdAt: timestamp }).nullable(),
    classes: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        archived: z.boolean(),
        release: releaseRef.nullable(),
      }),
    ),
  }),
  examples: { params: { courseId: exampleCourseId } },
});

import { z } from 'zod';
import { anchor, strokes } from '../anchors';
import { conflictBody, defineRoute } from '../define';

/**
 * Private annotations and class discussions (§8, §13). Every route is class-scoped; reads
 * return only what the audience rule permits the caller (ADR-0002). `resourceId` is the
 * draft resource id, stable across revisions; the server pins the class's adopted revision.
 */

const exampleClass = '00000000-0000-4000-8000-000000000000';
const exampleResource = '00000000-0000-4000-8000-0000000000bb';
const exampleAnnotation = '00000000-0000-4000-8000-0000000000cc';

const timestamp = z.iso.datetime({ offset: true });
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
const text = z.string().max(20_000);
const person = z.object({ id: z.uuid(), name: z.string() });
const sharedAudience = z.enum(['instructor', 'class']);

const classParams = z.object({ classId: z.uuid() });
const resourceParams = classParams.extend({ resourceId: z.uuid() });
const annotationParams = classParams.extend({ annotationId: z.uuid() });

export const annotationView = z.object({
  id: z.uuid(),
  resourceId: z.uuid(),
  resourceRevisionId: z.uuid(),
  kind: z.enum(['highlight', 'note', 'sketch']),
  /** Annotations are always private; sharing creates a separate thread. */
  audience: z.literal('private'),
  anchor,
  body: z.string().nullable(),
  color: z.string().nullable(),
  strokes: strokes.nullable(),
  /** Send back as `expectedRevision` with the next autosave. */
  revision: z.int(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const postView = z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  author: person,
  /** Null for a tombstone (deleted) or a post hidden by moderation. */
  body: z.string().nullable(),
  edited: z.boolean(),
  deleted: z.boolean(),
  moderated: z.boolean(),
  createdAt: timestamp,
});

export const threadView = z.object({
  id: z.uuid(),
  resourceId: z.uuid(),
  resourceRevisionId: z.uuid(),
  anchor,
  audience: sharedAudience,
  status: z.enum(['open', 'resolved']),
  author: person,
  createdAt: timestamp,
  posts: z.array(postView),
});

/** Highlights mark text or PDF regions; sketches sit on a figure or PDF page (§8). */
const anchorKinds = {
  highlight: ['text', 'pdf'],
  note: ['text', 'pdf', 'slide', 'figure', 'none'],
  sketch: ['figure', 'pdf'],
} as const;

export const createAnnotation = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/resources/:resourceId/annotations',
  scope: { kind: 'class', role: 'any' },
  summary: 'Save a private highlight, note or sketch on a resource of the class’s release',
  params: resourceParams,
  body: z
    .object({
      kind: z.enum(['highlight', 'note', 'sketch']),
      anchor,
      body: text.optional(),
      color: color.optional(),
      strokes: strokes.optional(),
    })
    .refine((b) => (anchorKinds[b.kind] as readonly string[]).includes(b.anchor.kind), {
      message: 'anchor kind does not fit this annotation kind',
      path: ['anchor'],
    })
    .refine((b) => b.kind === 'sketch' || b.strokes === undefined, {
      message: 'only sketches carry strokes',
      path: ['strokes'],
    }),
  response: annotationView,
  examples: {
    params: { classId: exampleClass, resourceId: exampleResource },
    body: { kind: 'note', anchor: { kind: 'none' }, body: 'Ask about the bootstrap.' },
  },
});

/** Autosave (§8): 409 with the server copy when `expectedRevision` is stale. */
export const saveAnnotation = defineRoute({
  method: 'PUT',
  path: '/api/classes/:classId/annotations/:annotationId',
  scope: { kind: 'class', role: 'any' },
  summary: 'Autosave changes to one of your annotations; 409 with the server copy on conflict',
  params: annotationParams,
  body: z.object({
    expectedRevision: z.int().positive(),
    body: text.nullable().optional(),
    color: color.nullable().optional(),
    strokes: strokes.nullable().optional(),
  }),
  response: annotationView,
  errors: { 409: conflictBody(annotationView) },
  examples: {
    params: { classId: exampleClass, annotationId: exampleAnnotation },
    body: { expectedRevision: 1, body: 'Ask about the bootstrap interval.' },
  },
});

export const deleteAnnotation = defineRoute({
  method: 'DELETE',
  path: '/api/classes/:classId/annotations/:annotationId',
  scope: { kind: 'class', role: 'any' },
  summary: 'Delete one of your annotations; threads shared from it remain',
  params: annotationParams,
  response: z.object({ id: z.uuid() }),
  examples: { params: { classId: exampleClass, annotationId: exampleAnnotation } },
});

export const listAnnotations = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/resources/:resourceId/annotations',
  scope: { kind: 'class', role: 'any' },
  summary: 'Your private annotations and the discussions you may read on one resource',
  params: resourceParams,
  response: z.object({ annotations: z.array(annotationView), threads: z.array(threadView) }),
  examples: { params: { classId: exampleClass, resourceId: exampleResource } },
});

/** Ask (§8): the audience is chosen explicitly and shown on the saved thread. */
export const createThread = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/resources/:resourceId/threads',
  scope: { kind: 'class', role: 'any' },
  summary: 'Post a question or comment to the instructors or the class',
  params: resourceParams,
  body: z.object({ audience: sharedAudience, anchor, body: text.trim().min(1) }),
  response: threadView,
  examples: {
    params: { classId: exampleClass, resourceId: exampleResource },
    body: { audience: 'instructor', anchor: { kind: 'none' }, body: 'Why n − 1?' },
  },
});

/**
 * The explicit action that turns a private note into shared content (§8): a new thread with
 * the note's anchor and quoted context only. The note itself stays private and unchanged.
 */
export const shareAnnotation = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/annotations/:annotationId/share',
  scope: { kind: 'class', role: 'any' },
  summary: 'Share one of your annotations as a new thread for the instructors or the class',
  params: annotationParams,
  body: z.object({ audience: sharedAudience, body: text.trim().min(1).optional() }),
  response: threadView,
  examples: {
    params: { classId: exampleClass, annotationId: exampleAnnotation },
    body: { audience: 'instructor' },
  },
});

export const notificationView = z.object({
  kind: z.literal('thread'),
  threadId: z.uuid(),
  resourceId: z.uuid(),
  audience: sharedAudience,
  author: person,
  excerpt: z.string(),
  createdAt: timestamp,
});

/** Newest discussions by others that the caller may read; the same audience rule applies. */
export const listNotifications = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/notifications',
  scope: { kind: 'class', role: 'any' },
  summary: 'Recent discussions in this class that you may read, newest first',
  params: classParams,
  response: z.object({ items: z.array(notificationView) }),
  examples: { params: { classId: exampleClass } },
});

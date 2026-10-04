import { z } from 'zod';
import { anchor, hexColor } from '../anchors';
import { classArchived, conflictBody, defineRoute, invalidBody } from '../define';
import { exampleIds } from '../examples';

/**
 * Private annotations and class discussions (§8, §13). Every route is class-scoped; reads
 * return only what the audience rule permits the caller (ADR-0002). `resourceId` is the
 * draft resource id, stable across revisions; the server pins the class's adopted revision.
 * Students reach a resource only once it is visible and its release time has passed. Writes
 * to an archived class answer 409 `{ error: 'class_archived' }`; reads keep working (§4).
 */

const exampleClass = exampleIds.zero;
const exampleResource = exampleIds.bb;
const exampleAnnotation = exampleIds.cc;

const timestamp = z.iso.datetime({ offset: true });
const color = hexColor;
const text = z.string().max(20_000);
const person = z.object({ id: z.uuid(), name: z.string() });
const sharedAudience = z.enum(['instructor', 'class']);

export { classArchived };

const classParams = z.object({ classId: z.uuid() });
const resourceParams = classParams.extend({ resourceId: z.uuid() });
const annotationParams = classParams.extend({ annotationId: z.uuid() });

/**
 * Where a mark sits in the revision the class uses now (ADR-0003). `original` when that is the
 * revision it was made on; `mapped` or `manual` with the anchor to show; `needs_reattachment`
 * when no confident match exists (show the original anchor's quote and context); `pending`
 * until the mapping job has run. Null when the class no longer studies the resource.
 */
export const placementView = z.object({
  resourceRevisionId: z.uuid(),
  status: z.enum(['original', 'mapped', 'manual', 'needs_reattachment', 'pending']),
  anchor: anchor.nullable(),
  confidence: z.number().min(0).max(1).nullable(),
});

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
  /** Send back as `expectedRevision` with the next autosave. */
  revision: z.int(),
  placement: placementView.nullable(),
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
  placement: placementView.nullable(),
  createdAt: timestamp,
  posts: z.array(postView),
});

/** Highlights mark text or PDF regions; sketches sit on a figure or PDF page (§8). */
const hasDrawing = (a: z.infer<typeof anchor>) =>
  (a.kind === 'figure' || a.kind === 'pdf') && (a.strokes?.length ?? 0) > 0;

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
    })
    .refine((b) => (anchorKinds[b.kind] as readonly string[]).includes(b.anchor.kind), {
      message: 'anchor kind does not fit this annotation kind',
      path: ['anchor'],
    })
    .refine((b) => b.kind !== 'sketch' || hasDrawing(b.anchor), {
      message: 'a sketch needs strokes on its anchor',
      path: ['anchor'],
    }),
  response: annotationView,
  errors: { 400: invalidBody, 409: classArchived },
  examples: {
    params: { classId: exampleClass, resourceId: exampleResource },
    body: { kind: 'note', anchor: { kind: 'none' }, body: 'Ask about the bootstrap.' },
  },
});

/**
 * Autosave (§8): 409 with the server copy when `expectedRevision` is stale. A request that
 * changes nothing returns the stored copy without a new revision. A replacement anchor keeps
 * the annotation's anchor kind (a redrawn sketch sends its anchor with the new strokes).
 */
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
    anchor: anchor.optional(),
  }),
  response: annotationView,
  errors: { 400: invalidBody, 409: z.union([conflictBody(annotationView), classArchived]) },
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
  errors: { 409: classArchived },
  examples: { params: { classId: exampleClass, annotationId: exampleAnnotation } },
});

/**
 * Your own annotations are listed even after the resource leaves the class's release or is
 * hidden (§12: removing a resource never deletes work); its threads only while you may study it.
 */
export const listAnnotations = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/resources/:resourceId/annotations',
  scope: { kind: 'class', role: 'any' },
  summary:
    'Your annotations on one resource, and its discussions you may read while the class studies it',
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
  errors: { 400: invalidBody, 409: classArchived },
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
  errors: { 400: invalidBody, 409: classArchived },
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

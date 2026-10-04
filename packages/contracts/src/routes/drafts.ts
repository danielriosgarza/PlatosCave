import { z } from 'zod';
import { conflictBody, defineRoute, invalidBody } from '../define';
import { resourceTypes } from '../resources';

/** Draft editing for a course (§12, ADR-0003). Class routes never read these rows (A26). */

const exampleCourseId = '00000000-0000-4000-8000-000000000000';
const exampleTopicId = '00000000-0000-4000-8000-0000000000aa';
const exampleResourceId = '00000000-0000-4000-8000-0000000000bb';

export { resourceTypes };

const json = z.record(z.string(), z.unknown());
const title = z.string().trim().min(1).max(300);
const position = z.int().min(0);
const timestamp = z.iso.datetime({ offset: true });
/** The optimistic check every mutation carries: the `revision` the editor last saw. */
const expectedRevision = z.int().positive();
/** Archive and restore replace deletion (§12); permanent deletion is a retention operation. */
const archived = z.boolean();

export const draftTopic = z.object({
  id: z.uuid(),
  courseId: z.uuid(),
  position: z.int(),
  title: z.string(),
  objective: z.string(),
  prerequisites: z.array(z.uuid()),
  completionRule: json.nullable(),
  estimatedMinutes: z.int().nullable(),
  revision: z.int(),
  archived: z.boolean(),
  updatedAt: timestamp,
});

export const draftResourceSummary = z.object({
  id: z.uuid(),
  courseId: z.uuid(),
  topicId: z.uuid(),
  type: z.enum(resourceTypes),
  title: z.string(),
  position: z.int(),
  visibility: z.enum(['visible', 'hidden']),
  releaseAt: timestamp.nullable(),
  headRevisionId: z.uuid().nullable(),
  revision: z.int(),
  archived: z.boolean(),
  updatedAt: timestamp,
});

/** One immutable revision's content; for tests it includes hidden checks (editors only). */
export const resourceRevisionView = z.object({
  id: z.uuid(),
  content: json,
  objectKeys: z.array(z.string()),
  accessibleAlternative: json.nullable(),
  provenance: json.nullable(),
  contentHash: z.string(),
  createdBy: z.uuid(),
  createdAt: timestamp,
});

export const draftResource = draftResourceSummary.extend({
  head: resourceRevisionView.nullable(),
});

/** Fields that make up a revision; changing any of them may create a new one. */
const revisionFields = {
  content: json.optional(),
  objectKeys: z.array(z.string().min(1)).max(200).optional(),
  accessibleAlternative: json.nullable().optional(),
  provenance: json.nullable().optional(),
};

const courseParams = z.object({ courseId: z.uuid() });
const topicParams = courseParams.extend({ topicId: z.uuid() });
const resourceParams = courseParams.extend({ resourceId: z.uuid() });

export const listDrafts = defineRoute({
  method: 'GET',
  path: '/api/courses/:courseId/drafts',
  scope: { kind: 'course', role: 'editor' },
  summary: 'Draft topics of a course in order, each with its draft resources, archived included',
  params: courseParams,
  response: z.object({
    topics: z.array(draftTopic.extend({ resources: z.array(draftResourceSummary) })),
  }),
  examples: { params: { courseId: exampleCourseId } },
});

export const createTopic = defineRoute({
  method: 'POST',
  path: '/api/courses/:courseId/topics',
  scope: { kind: 'course', role: 'editor' },
  summary: 'Add a draft topic; it goes last unless a position is given',
  params: courseParams,
  body: z.object({
    title,
    objective: z.string().max(2000).optional(),
    position: position.optional(),
    prerequisites: z.array(z.uuid()).max(50).optional(),
    completionRule: json.nullable().optional(),
    estimatedMinutes: z.int().min(0).max(10_000).nullable().optional(),
  }),
  response: draftTopic,
  examples: { params: { courseId: exampleCourseId }, body: { title: 'Sampling distributions' } },
});

export const updateTopic = defineRoute({
  method: 'PATCH',
  path: '/api/courses/:courseId/topics/:topicId',
  scope: { kind: 'course', role: 'editor' },
  summary:
    'Change a draft topic, archive or restore it; 409 with the server copy on a stale revision',
  params: topicParams,
  body: z.object({
    expectedRevision,
    title: title.optional(),
    objective: z.string().max(2000).optional(),
    position: position.optional(),
    prerequisites: z.array(z.uuid()).max(50).optional(),
    completionRule: json.nullable().optional(),
    estimatedMinutes: z.int().min(0).max(10_000).nullable().optional(),
    archived: archived.optional(),
  }),
  response: draftTopic,
  errors: { 409: conflictBody(draftTopic) },
  examples: {
    params: { courseId: exampleCourseId, topicId: exampleTopicId },
    body: { expectedRevision: 1, title: 'Sampling' },
  },
});

export const createResource = defineRoute({
  method: 'POST',
  path: '/api/courses/:courseId/topics/:topicId/resources',
  scope: { kind: 'course', role: 'editor' },
  summary: 'Add a draft resource to a topic; content, when given, becomes its first revision',
  params: topicParams,
  body: z.object({
    type: z.enum(resourceTypes),
    title,
    position: position.optional(),
    visibility: z.enum(['visible', 'hidden']).optional(),
    releaseAt: timestamp.nullable().optional(),
    ...revisionFields,
  }),
  response: draftResource,
  errors: { 400: invalidBody },
  examples: {
    params: { courseId: exampleCourseId, topicId: exampleTopicId },
    body: { type: 'reading_native', title: 'Why samples vary', content: { markdown: '# Why' } },
  },
});

export const getResource = defineRoute({
  method: 'GET',
  path: '/api/courses/:courseId/resources/:resourceId',
  scope: { kind: 'course', role: 'editor' },
  summary: 'One draft resource with the content of its head revision',
  params: resourceParams,
  response: draftResource,
  examples: { params: { courseId: exampleCourseId, resourceId: exampleResourceId } },
});

export const updateResource = defineRoute({
  method: 'PATCH',
  path: '/api/courses/:courseId/resources/:resourceId',
  scope: { kind: 'course', role: 'editor' },
  summary:
    'Change a draft resource; changed content adds a revision, unchanged content keeps the head; 409 with the server copy on a stale revision',
  params: resourceParams,
  body: z.object({
    expectedRevision,
    topicId: z.uuid().optional(),
    title: title.optional(),
    position: position.optional(),
    visibility: z.enum(['visible', 'hidden']).optional(),
    releaseAt: timestamp.nullable().optional(),
    archived: archived.optional(),
    ...revisionFields,
  }),
  response: draftResource,
  errors: { 400: invalidBody, 409: conflictBody(draftResource) },
  examples: {
    params: { courseId: exampleCourseId, resourceId: exampleResourceId },
    body: { expectedRevision: 1, content: { markdown: '# Why samples vary' } },
  },
});

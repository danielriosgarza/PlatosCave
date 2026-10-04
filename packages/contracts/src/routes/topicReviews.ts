import { z } from 'zod';
import { classArchived, defineRoute, invalidBody } from '../define';
import { exampleIds } from '../examples';
import { topicTab } from './topics';

/**
 * Reviewed marks (§4). A student marks ungraded material of an open topic reviewed, or takes the
 * mark back. The marks and the course's completion rule decide when a topic is complete; the
 * result is a statement of what the student did, never a grade.
 */

export const reviewItem = z.object({
  resourceId: z.uuid(),
  title: z.string(),
  tab: topicTab,
  /** Graded work takes no mark: it counts through its submission. */
  graded: z.boolean(),
  /** The student's own mark; always false for graded work. */
  reviewed: z.boolean(),
  /** The student has submitted this resource (notebooks). */
  submitted: z.boolean(),
  /** What the topic's completion rule asks of this resource, if anything. */
  required: z.enum(['review', 'submission']).nullable(),
});

export const topicReviews = z.object({
  topicId: z.uuid(),
  /** The completion rule is met; not a grade. */
  complete: z.boolean(),
  items: z.array(reviewItem),
});

export const getTopicReviews = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/topics/:topicId/reviews',
  scope: { kind: 'class', role: 'student' },
  summary: 'The material of a topic the caller can mark reviewed, with their marks and completion',
  params: z.object({ classId: z.uuid(), topicId: z.uuid() }),
  response: topicReviews,
  examples: { params: { classId: exampleIds.zero, topicId: exampleIds.aa } },
});

export const putReviewed = defineRoute({
  method: 'PUT',
  path: '/api/classes/:classId/topics/:topicId/reviews/:resourceId',
  scope: { kind: 'class', role: 'student' },
  summary: 'Mark one ungraded resource of an open topic reviewed, or clear the mark',
  params: z.object({ classId: z.uuid(), topicId: z.uuid(), resourceId: z.uuid() }),
  body: z.object({ reviewed: z.boolean() }),
  response: topicReviews,
  errors: { 400: invalidBody, 409: classArchived },
  examples: {
    params: { classId: exampleIds.zero, topicId: exampleIds.aa, resourceId: exampleIds.bb },
    body: { reviewed: true },
  },
});

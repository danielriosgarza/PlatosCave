import { z } from 'zod';
import { classArchived, defineRoute } from '../define';
import { exampleIds } from '../examples';

const params = z.object({ classId: z.uuid() });

export const getClass = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId',
  scope: { kind: 'class', role: 'any' },
  summary: 'One class as seen by a member: cohort, course, adopted release and own role',
  params,
  response: z.object({
    id: z.uuid(),
    name: z.string(),
    courseId: z.uuid(),
    courseTitle: z.string(),
    releaseId: z.uuid().nullable(),
    archived: z.boolean(),
    /** An open class (§13, N10): nobody posts to the class or to instructors. */
    open: z.boolean(),
    role: z.enum(['student', 'instructor']),
    grants: z.object({ manageMembers: z.boolean() }),
  }),
  examples: { params: { classId: exampleIds.zero } },
});

/**
 * Opens the class (§13, N10) or closes it again; a class is not open unless set. In an open class
 * the server refuses every new post to the class or to instructors, and private notes still save.
 * Nobody grades in an open class: 409 `manual_grading` when opening one whose adopted release has
 * manually graded test parts. Setting the value the class has changes nothing. Audited as
 * `class.open`.
 */
export const setClassOpen = defineRoute({
  method: 'PUT',
  path: '/api/classes/:classId/open',
  scope: { kind: 'class', role: 'instructor', grant: 'manage_members' },
  summary: 'Make the class an open class, where nobody posts or grades, or end that',
  params,
  body: z.object({ open: z.boolean() }),
  response: z.object({ id: z.uuid(), open: z.boolean() }),
  errors: { 409: z.union([classArchived, z.object({ error: z.literal('manual_grading') })]) },
  examples: { params: { classId: exampleIds.zero }, body: { open: true } },
});

import { z } from 'zod';
import { defineRoute } from '../define';

export const getClass = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId',
  scope: { kind: 'class', role: 'any' },
  summary: 'One class as seen by a member: cohort, course, adopted release and own role',
  params: z.object({ classId: z.uuid() }),
  response: z.object({
    id: z.uuid(),
    name: z.string(),
    courseId: z.uuid(),
    courseTitle: z.string(),
    releaseId: z.uuid().nullable(),
    archived: z.boolean(),
    role: z.enum(['student', 'instructor']),
    grants: z.object({ manageMembers: z.boolean() }),
  }),
  examples: { params: { classId: '00000000-0000-4000-8000-000000000000' } },
});

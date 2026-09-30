import { z } from 'zod';
import { defineRoute } from '../define';

export const me = defineRoute({
  method: 'GET',
  path: '/api/me',
  scope: { kind: 'user' },
  summary: 'The signed-in person and the class and course contexts they hold',
  response: z.object({
    user: z.object({
      id: z.uuid(),
      name: z.string(),
      email: z.string().nullable(),
      kind: z.enum(['user', 'preview']),
    }),
    classes: z.array(
      z.object({
        classId: z.uuid(),
        className: z.string(),
        courseId: z.uuid(),
        courseTitle: z.string(),
        role: z.enum(['student', 'instructor']),
        manageMembers: z.boolean(),
        isPreview: z.boolean(),
      }),
    ),
    courses: z.array(
      z.object({
        courseId: z.uuid(),
        title: z.string(),
        owner: z.boolean(),
        editor: z.boolean(),
        publisher: z.boolean(),
      }),
    ),
  }),
  examples: {},
});

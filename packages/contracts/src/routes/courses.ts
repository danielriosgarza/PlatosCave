import { z } from 'zod';
import { defineRoute } from '../define';
import { tabs } from '../resources';

const tab = z.enum(tabs);

/** Where a student last studied in a class (§4): the saved resource inside the adopted release. */
const resume = z.object({
  topicId: z.uuid(),
  topicTitle: z.string(),
  tab,
  resourceTitle: z.string(),
});

/**
 * The person's class contexts and the courses they hold permissions on, each with only what
 * their own role shows (§3, §4). `reviewed` is the personal count against the topics of the
 * adopted release the course's completion rule counts as reviewed; it is never a grade.
 */
export const listCourses = defineRoute({
  method: 'GET',
  path: '/api/courses',
  scope: { kind: 'user' },
  summary: 'Course cards for the signed-in person: enrolled classes, teaching classes and courses',
  response: z.object({
    classes: z.array(
      z.object({
        classId: z.uuid(),
        className: z.string(),
        courseId: z.uuid(),
        courseTitle: z.string(),
        role: z.enum(['student', 'instructor']),
        archived: z.boolean(),
        /** The class's course is archived, which is why the class shows archived and cannot be restored on its own (§13). */
        courseArchived: z.boolean(),
        topicCount: z.number().int().min(0),
        reviewed: z.object({ count: z.number().int().min(0), total: z.number().int().min(0) }),
        /** Students only: null before the first saved position. */
        resume: resume.nullable(),
        studentCount: z.number().int().min(0).nullable(),
      }),
    ),
    courses: z.array(
      z.object({
        courseId: z.uuid(),
        title: z.string(),
        owner: z.boolean(),
        editor: z.boolean(),
        publisher: z.boolean(),
        /** The course is archived: its classes are read-only and its draft takes no edits (§13). */
        archived: z.boolean(),
        topicCount: z.number().int().min(0),
        classCount: z.number().int().min(0),
      }),
    ),
    /** Whether `POST /api/courses` would accept this person, so the page offers Create course. */
    canCreateCourse: z.boolean(),
  }),
  examples: {},
});

/**
 * Only an account that already teaches (an instructor class membership or a course grant), or
 * whose email is on the configured INSTRUCTOR_EMAILS list, may create a course; creating one
 * grants its creator the owner membership. 403 `not_instructor`.
 */
export const createCourse = defineRoute({
  method: 'POST',
  path: '/api/courses',
  scope: { kind: 'user' },
  summary: 'Create a course owned by the signed-in instructor',
  body: z.object({ title: z.string().trim().min(1).max(160) }),
  response: z.object({ id: z.uuid(), title: z.string() }),
  errors: { 403: z.object({ error: z.literal('not_instructor') }) },
  examples: { body: { title: 'Introduction to statistics' } },
});

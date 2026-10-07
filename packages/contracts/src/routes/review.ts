import { z } from 'zod';
import { defineRoute } from '../define';
import { exampleIds } from '../examples';
import { testAttemptStates } from '../test';
import { threadView } from './annotations';

/**
 * The class review table (§12). An instructor compares real students (preview principals and
 * removed students excluded) across the same assignments: exercise status, test status and
 * score, open questions and the last submitted work. The filters name a topic, an assignment
 * (a test of the class), one student, or Needs review (an attempt in scope that is submitted but
 * not yet released). `students` lists the whole filtered list in table order, so previous/next
 * student traverses it whatever page the table shows.
 */

const timestamp = z.iso.datetime({ offset: true });
const flag = z.enum(['true', 'false']).transform((v) => v === 'true');

export const reviewQuery = z.object({
  topicId: z.uuid().optional().catch(undefined),
  /** The test resource the assignment is for. */
  assignmentId: z.uuid().optional().catch(undefined),
  studentId: z.uuid().optional().catch(undefined),
  /** The attempt the instructor has open, kept visible beside the recipient. */
  attemptId: z.uuid().optional().catch(undefined),
  needsReview: flag.optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).catch(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).catch(25).default(25),
});

/** A grade's score: a draft is the instructor's only; a released one is the student's. */
export const reviewScore = z.object({
  points: z.number(),
  possible: z.number(),
  state: z.enum(['draft', 'released']),
});

export const reviewAttempt = z.object({
  attemptId: z.uuid(),
  number: z.int(),
  state: z.enum(testAttemptStates),
  submittedAt: timestamp.nullable(),
  /** The newest released grade, else the newest draft; null when the attempt has no grade. */
  score: reviewScore.nullable(),
  /**
   * A draft saved after release (a regrade or an override) waits for release while the attempt
   * stays released: the student still sees the released grade and the instructor has work left.
   */
  unreleasedChange: z.boolean(),
  /** The newest grade of the attempt, released or not; changes with every saved draft. */
  gradeId: z.uuid().nullable(),
});

export const reviewRow = z.object({
  studentId: z.uuid(),
  name: z.string(),
  /** Exercises of the filtered topics the student has completed, of those the class has. */
  exercises: z.object({ completed: z.int(), total: z.int() }),
  /** Tests in scope the student has submitted or had released, of those the class has. */
  tests: z.object({ submitted: z.int(), released: z.int(), total: z.int() }),
  /** With an assignment filter: the student's newest attempt at it. */
  attempt: reviewAttempt.nullable(),
  /** Some attempt in scope awaits an instructor (submitted, not released). */
  needsReview: z.boolean(),
  /** Open threads the student started that an instructor can read. */
  openQuestions: z.int(),
  lastSubmission: z.object({ at: timestamp, kind: z.enum(['test', 'notebook']) }).nullable(),
});

export const classReview = z.object({
  topics: z.array(z.object({ topicId: z.uuid(), number: z.int(), title: z.string() })),
  assignments: z.array(z.object({ assignmentId: z.uuid(), title: z.string(), topicId: z.uuid() })),
  /** The class's notebooks in the topic filter, whose submitted snapshots the Submissions tab lists. */
  notebooks: z.array(z.object({ notebookId: z.uuid(), title: z.string(), topicId: z.uuid() })),
  /** The class's exercises in the topic filter, whose practice attempts the Exercises tab lists. */
  exercises: z.array(z.object({ exerciseId: z.uuid(), title: z.string(), topicId: z.uuid() })),
  /** Every real student of the class, for the student filter. */
  roster: z.array(z.object({ id: z.uuid(), name: z.string() })),
  /** The filtered students in table order: the list previous/next traverses. */
  students: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      /** With an assignment filter: the student's newest attempt at it, so the header can show it. */
      attempt: z.object({ attemptId: z.uuid(), number: z.int() }).nullable(),
    }),
  ),
  total: z.int(),
  page: z.int(),
  pageSize: z.int(),
  rows: z.array(reviewRow),
  /** The assignment filter, as the class has it; null without one. */
  assignment: z.object({ assignmentId: z.uuid(), title: z.string() }).nullable(),
  /** The open attempt and its student, current or removed; null otherwise. */
  selected: z
    .object({
      studentId: z.uuid(),
      /** The student's name, so a removed student's open attempt can be headed too. */
      studentName: z.string(),
      attemptId: z.uuid(),
      number: z.int(),
      assignmentId: z.uuid(),
    })
    .nullable(),
});

export const getClassReview = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/review',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'Instructor: the class review table of students, filtered and paginated',
  params: z.object({ classId: z.uuid() }),
  query: reviewQuery,
  response: classReview,
  examples: { params: { classId: exampleIds.zero }, query: {} },
});

/**
 * One question or comment a student started, with the resource it is about, so an instructor can
 * open the source passage. `resource` is null when the class's release no longer carries it.
 */
export const studentDiscussion = z.object({
  thread: threadView,
  resource: z.object({ title: z.string(), tab: z.string(), topicId: z.uuid() }).nullable(),
});

export const getStudentDiscussions = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/students/:studentId/discussions',
  scope: { kind: 'class', role: 'instructor' },
  summary:
    'Instructor: the questions and comments one student shared with instructors or the class',
  params: z.object({ classId: z.uuid(), studentId: z.uuid() }),
  response: z.object({ discussions: z.array(studentDiscussion) }),
  examples: { params: { classId: exampleIds.zero, studentId: exampleIds.cc } },
});

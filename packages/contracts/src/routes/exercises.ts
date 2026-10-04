import { z } from 'zod';
import { conflictBody, defineRoute, invalidBody } from '../define';
import { exampleIds } from '../examples';
import { exerciseCredit, exerciseStepView } from '../exercise';
import { classArchived } from './annotations';

/**
 * Practice attempts on `exercise` resources (§9, §13). Every route is class-scoped; an
 * attempt belongs to one student and is pinned to the revision it started on, so the
 * instructor sees what the student saw. Events (checks, hints, solutions, completed steps,
 * restarts) are append-only: hiding a hint or starting again never erases them (A23).
 */

const exampleClass = exampleIds.zero;
const exampleResource = exampleIds.bb;
const exampleAttempt = exampleIds.dd;

const timestamp = z.iso.datetime({ offset: true });
/** How a step or an exercise was completed; never collapsed into a percentage (§9). */
export const exerciseHelp = z.enum(['independent', 'with_hints', 'solution_shown']);

const resourceParams = z.object({ classId: z.uuid(), resourceId: z.uuid() });
const attemptParams = z.object({ classId: z.uuid(), attemptId: z.uuid() });
const stepRef = z.object({ stepId: z.string().min(1).max(40) });

export const attemptStepView = exerciseStepView.extend({
  status: z.enum(['pending', 'completed']),
  /** Set once the step is completed. */
  help: exerciseHelp.nullable(),
  checks: z.int(),
  /** Hints revealed so far, in order. */
  hints: z.array(z.string()),
  /** The solution, once revealed. */
  solution: z.string().nullable(),
  /** The last response recorded for this step: wrong answers keep the learner's work. */
  response: z.unknown(),
  /** Feedback on that response. */
  feedback: z.string().nullable(),
  /** Simulation values compared so far. */
  compared: z.array(z.number()).optional(),
});

export const attemptView = z.object({
  id: z.uuid(),
  resourceId: z.uuid(),
  resourceRevisionId: z.uuid(),
  number: z.int(),
  /** Seeds the option order and any simulation draws, so a replay matches what was seen. */
  seed: z.int(),
  completion: exerciseHelp.nullable(),
  completedAt: timestamp.nullable(),
  startedAt: timestamp,
  /** Points and hint policy when the exercise is for credit; null for ungraded practice (§9). */
  credit: exerciseCredit.nullable(),
  steps: z.array(attemptStepView),
});

/** 409: another tab superseded the attempt (the server's copy), or the class is archived (§4). */
const stale = { 400: invalidBody, 409: z.union([conflictBody(attemptView), classArchived]) };

/** Resume the current attempt, or start the first one on the class's revision. */
export const openExercise = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/resources/:resourceId/exercise-attempt',
  scope: { kind: 'class', role: 'any' },
  summary: 'Resume your current practice attempt on an exercise, or start one',
  params: resourceParams,
  response: attemptView,
  errors: { 400: invalidBody, 409: classArchived },
  examples: { params: { classId: exampleClass, resourceId: exampleResource } },
});

/**
 * Check answer: records the response and returns targeted feedback. A malformed response is
 * refused (400) and not recorded; a wrong one is recorded and may be retried.
 */
export const checkStep = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/exercise-attempts/:attemptId/check',
  scope: { kind: 'class', role: 'any' },
  summary: 'Check a response to the active step; wrong answers are kept and may be retried',
  params: attemptParams,
  body: stepRef.extend({ response: z.unknown() }),
  response: z.object({
    attempt: attemptView,
    result: z.object({ correct: z.boolean(), feedback: z.string() }),
  }),
  errors: stale,
  examples: {
    params: { classId: exampleClass, attemptId: exampleAttempt },
    body: { stepId: 'predict', response: 'narrower' },
  },
});

export const showHint = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/exercise-attempts/:attemptId/hint',
  scope: { kind: 'class', role: 'any' },
  summary: 'Reveal the next hint of a step; its use is recorded',
  params: attemptParams,
  body: stepRef,
  response: attemptView,
  errors: stale,
  examples: {
    params: { classId: exampleClass, attemptId: exampleAttempt },
    body: { stepId: 'predict' },
  },
});

/** Show solution: a separate event that completes the step with help (§9). */
export const showSolution = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/exercise-attempts/:attemptId/solution',
  scope: { kind: 'class', role: 'any' },
  summary: 'Reveal the solution of a step and complete it with help',
  params: attemptParams,
  body: stepRef,
  response: attemptView,
  errors: stale,
  examples: {
    params: { classId: exampleClass, attemptId: exampleAttempt },
    body: { stepId: 'predict' },
  },
});

/** Saves an explanation or code; empty text cannot complete the step (A23). */
export const completeStep = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/exercise-attempts/:attemptId/complete',
  scope: { kind: 'class', role: 'any' },
  summary: 'Save the written response of the active step and complete it',
  params: attemptParams,
  body: stepRef.extend({ response: z.string().max(20_000) }),
  response: attemptView,
  errors: stale,
  examples: {
    params: { classId: exampleClass, attemptId: exampleAttempt },
    body: { stepId: 'explain', response: 'Larger samples average out more noise.' },
  },
});

/** Start again: a new attempt; the previous attempt and its evidence are kept. */
export const restartExercise = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/exercise-attempts/:attemptId/restart',
  scope: { kind: 'class', role: 'any' },
  summary: 'Start a new practice attempt; the previous one is kept',
  params: attemptParams,
  response: attemptView,
  errors: stale,
  examples: { params: { classId: exampleClass, attemptId: exampleAttempt } },
});

export const reviewStep = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.string(),
  status: z.enum(['pending', 'completed']),
  help: exerciseHelp.nullable(),
  checks: z.array(z.object({ response: z.unknown(), correct: z.boolean(), at: timestamp })),
  hintsShown: z.int(),
  solutionShown: z.boolean(),
  /** The response that completed the step, if any. */
  finalResponse: z.unknown(),
});

export const reviewAttempt = z.object({
  id: z.uuid(),
  student: z.object({ id: z.uuid(), name: z.string() }),
  number: z.int(),
  resourceRevisionId: z.uuid(),
  seed: z.int(),
  startedAt: timestamp,
  completion: exerciseHelp.nullable(),
  completedAt: timestamp.nullable(),
  restarted: z.boolean(),
  steps: z.array(reviewStep),
});

/** Instructor review (§9): answers, checked attempts, hints and solutions, per attempt. */
export const reviewExercise = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/resources/:resourceId/exercise-attempts',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'Students’ practice attempts on an exercise with checks, hints and solutions used',
  params: resourceParams,
  response: z.object({ attempts: z.array(reviewAttempt) }),
  examples: { params: { classId: exampleClass, resourceId: exampleResource } },
});

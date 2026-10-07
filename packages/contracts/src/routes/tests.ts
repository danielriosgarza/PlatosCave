import { z } from 'zod';
import { classArchived, conflictBody, defineRoute, invalidBody } from '../define';
import { exampleIds } from '../examples';
import {
  assignmentSettings,
  assignmentSettingsPatch,
  testAttemptStates,
  testQuestionView,
} from '../test';

/**
 * Assigned tests and their attempts (§11, §13). Every route is class-scoped. The server decides
 * eligibility, deadlines and lateness; the browser clock decides nothing. A student reads and
 * writes only their own attempts; instructors set the class's terms, grant extensions and read
 * every student's attempts with the pinned revision, grader version and rubric (A16).
 */

const exampleClass = exampleIds.zero;
const exampleResource = exampleIds.bb;
const exampleAttempt = exampleIds.dd;

const timestamp = z.iso.datetime({ offset: true });
const resourceParams = z.object({ classId: z.uuid(), resourceId: z.uuid() });
const attemptParams = z.object({ classId: z.uuid(), attemptId: z.uuid() });
const questionId = z.string().min(1).max(40);

/** A student's extension or extra attempts as granted; null when none is in force. */
export const overrideTerms = z.object({
  extraAttempts: z.int(),
  extraMinutes: z.int(),
  closesAt: timestamp.nullable(),
});

/** The terms that apply to this student: the class's settings with their override applied. */
export const effectiveTerms = assignmentSettings.extend({
  override: overrideTerms.nullable(),
  totalPoints: z.number(),
});

/** The server's acknowledgement of one saved answer; only this justifies "Saved". */
export const answerAck = z.object({
  questionId,
  /** The client's counter for this question; a lower one never replaces a higher one. */
  seq: z.int(),
  savedAt: timestamp,
});

/**
 * The acknowledgement of one autosave. `applied` says whether this request's value is the one the
 * server now holds; when it is false the server kept an answer with a counter at or above this
 * save's (another tab or device, or an earlier copy of this save), and `seq` is that answer's.
 */
export const saveAck = answerAck.extend({ applied: z.boolean() });

/**
 * Given only after the server has stored the submission (§11): which answers it received, as
 * acknowledged, and which questions it received nothing for.
 */
export const submissionReceipt = z.object({
  submissionId: z.uuid(),
  attemptId: z.uuid(),
  submittedAt: timestamp,
  /** Submitted by the server at the deadline from the last acknowledged answers. */
  autoSubmitted: z.boolean(),
  late: z.boolean(),
  answers: z.array(answerAck),
  unanswered: z.array(questionId),
});

export const attemptSummary = z.object({
  id: z.uuid(),
  number: z.int(),
  state: z.enum(testAttemptStates),
  resourceRevisionId: z.uuid(),
  startedAt: timestamp,
  /** When the server submits what it has; null when nothing closes the attempt. */
  deadlineAt: timestamp.nullable(),
  submittedAt: timestamp.nullable(),
  receipt: submissionReceipt.nullable(),
  /** When unsent work from the student's browser was kept for recovery; never a submission. */
  localCopyAt: timestamp.nullable(),
  /** When an instructor last asked for the work the student's browser may still hold; null if never. */
  recoveryRequestedAt: timestamp.nullable(),
});

export const ineligibility = z.enum([
  'not_open',
  'closed',
  'no_attempts_left',
  'in_progress',
  'class_archived',
]);

export const testOverview = z.object({
  resourceId: z.uuid(),
  /** The revision a new attempt starts on. */
  resourceRevisionId: z.uuid(),
  terms: effectiveTerms,
  questionCount: z.int(),
  /** The caller's own attempts, newest first. */
  attempts: z.array(attemptSummary),
  eligibility: z.object({
    canStart: z.boolean(),
    reason: ineligibility.nullable(),
    attemptsUsed: z.int(),
    attemptsAllowed: z.int(),
  }),
  serverNow: timestamp,
});

/** Assignment terms, the caller's attempts and whether they may start one now. */
export const readTest = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/resources/:resourceId/test',
  scope: { kind: 'class', role: 'any' },
  summary: 'Read a test’s terms, your attempts and whether you may start one',
  params: resourceParams,
  response: testOverview,
  errors: { 400: invalidBody },
  examples: { params: { classId: exampleClass, resourceId: exampleResource } },
});

export const attemptView = attemptSummary.extend({
  graderVersion: z.string(),
  /** The terms in force for this attempt. */
  terms: effectiveTerms,
  questions: z.array(testQuestionView),
  /** The last acknowledged answer to each question. */
  answers: z.array(answerAck.extend({ value: z.unknown(), flagged: z.boolean() })),
  serverNow: timestamp,
});

/** Start: eligibility is checked by the server; an attempt in progress is resumed instead. */
export const startTestAttempt = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/resources/:resourceId/test-attempts',
  scope: { kind: 'class', role: 'any' },
  allowWhenArchived: true,
  summary: 'Resume your attempt in progress, or start a new one if you are eligible',
  params: resourceParams,
  response: attemptView,
  errors: {
    400: invalidBody,
    409: z.union([
      classArchived,
      z.object({ error: z.literal('not_eligible'), reason: ineligibility }),
    ]),
  },
  examples: { params: { classId: exampleClass, resourceId: exampleResource } },
});

/** Reconnect: the server's state of the attempt, settled first if its deadline has passed. */
export const readTestAttempt = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/test-attempts/:attemptId',
  scope: { kind: 'class', role: 'any' },
  summary: 'Read one of your attempts as the server holds it',
  params: attemptParams,
  response: attemptView,
  examples: { params: { classId: exampleClass, attemptId: exampleAttempt } },
});

/** 409 when the attempt no longer takes answers: its receipt says what the server received. */
const closed = z.object({
  error: z.enum(['attempt_closed', 'already_submitted']),
  receipt: submissionReceipt.nullable(),
});

export const saveTestAnswer = defineRoute({
  method: 'PUT',
  path: '/api/classes/:classId/test-attempts/:attemptId/answers/:questionId',
  scope: { kind: 'class', role: 'any' },
  summary: 'Autosave one answer of your attempt in progress',
  params: attemptParams.extend({ questionId }),
  body: z.object({ value: z.unknown(), flagged: z.boolean().default(false), seq: z.int().min(1) }),
  response: saveAck,
  errors: { 400: invalidBody, 409: z.union([closed, classArchived]) },
  examples: {
    params: { classId: exampleClass, attemptId: exampleAttempt, questionId: 'q1' },
    body: { value: ['a'], flagged: false, seq: 1 },
  },
});

/**
 * Submit test: freezes the attempt's acknowledged answers. The same key answers the same receipt
 * however often it is sent (A14); another key for a submitted attempt answers 409 with it.
 */
export const submitTestAttempt = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/test-attempts/:attemptId/submit',
  scope: { kind: 'class', role: 'any' },
  allowWhenArchived: true,
  summary: 'Submit your attempt; repeating the request returns the same receipt',
  params: attemptParams,
  body: z.object({ submissionKey: z.string().min(8).max(100) }),
  response: submissionReceipt,
  errors: { 400: invalidBody, 409: z.union([closed, classArchived]) },
  examples: {
    params: { classId: exampleClass, attemptId: exampleAttempt },
    body: { submissionKey: 'submit-0001' },
  },
});

/**
 * Keeps work the browser still held when the attempt closed, for an instructor recovery request
 * (§11, A15). It changes neither the attempt nor its receipt.
 */
export const keepLocalCopy = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/test-attempts/:attemptId/local-copy',
  scope: { kind: 'class', role: 'any' },
  summary: 'Keep unsent work from a closed attempt for recovery; it is not submitted',
  params: attemptParams,
  body: z.object({
    answers: z
      .array(z.object({ questionId, value: z.unknown() }))
      .min(1)
      .max(100),
  }),
  response: z.object({ localCopyAt: timestamp }),
  errors: { 400: invalidBody, 409: z.object({ error: z.literal('attempt_open') }) },
  examples: {
    params: { classId: exampleClass, attemptId: exampleAttempt },
    body: { answers: [{ questionId: 'q1', value: ['a'] }] },
  },
});

/**
 * Instructor: asks the student to send the unsent work their browser kept for a closed attempt
 * (§11, A15). It changes neither the attempt nor its receipt; the student's page shows the request
 * and the student answers it by sending the copy (`keepLocalCopy`).
 */
export const requestRecovery = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/test-attempts/:attemptId/recovery-request',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'Ask a student for the unsent local work of a closed attempt, with a reason',
  params: attemptParams,
  body: z.object({ reason: z.string().trim().min(1).max(500) }),
  status: 201,
  response: z.object({ requestedAt: timestamp }),
  errors: {
    400: invalidBody,
    409: z.object({ error: z.enum(['attempt_open', 'student_removed', 'class_archived']) }),
  },
  examples: {
    params: { classId: exampleClass, attemptId: exampleAttempt },
    body: { reason: 'The connection dropped before the deadline' },
  },
});

export const grantedOverride = overrideTerms.extend({
  id: z.uuid(),
  student: z.object({ id: z.uuid(), name: z.string() }),
  reason: z.string(),
  grantedBy: z.uuid(),
  createdAt: timestamp,
});

export const assignmentView = z.object({
  resourceId: z.uuid(),
  /** The class's own settings; the rest come from the test's revision and the defaults. */
  settings: assignmentSettingsPatch,
  effective: assignmentSettings,
  /** Null until the class's settings are first saved. */
  revision: z.int().nullable(),
  /** The override in force for each student who has one. */
  overrides: z.array(grantedOverride),
});

export const readAssignment = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/resources/:resourceId/assignment',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'Read the class’s terms for a test and the overrides in force',
  params: resourceParams,
  response: assignmentView,
  errors: { 400: invalidBody },
  examples: { params: { classId: exampleClass, resourceId: exampleResource } },
});

/** Changes the class's terms; attempts already started keep the terms they started with. */
export const updateAssignment = defineRoute({
  method: 'PUT',
  path: '/api/classes/:classId/resources/:resourceId/assignment',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'Set the class’s terms for a test',
  params: resourceParams,
  body: z.object({
    settings: assignmentSettingsPatch,
    /** The revision this edit is based on; null for the first save. */
    expectedRevision: z.int().nullable(),
  }),
  response: assignmentView,
  errors: { 400: invalidBody, 409: z.union([conflictBody(assignmentView), classArchived]) },
  examples: {
    params: { classId: exampleClass, resourceId: exampleResource },
    body: { settings: { attempts: 2 }, expectedRevision: null },
  },
});

/**
 * Grants a student an extension or extra attempts with a reason (§11). The grant replaces the
 * override in force and moves the deadline of their attempt in progress.
 */
export const grantOverride = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/resources/:resourceId/overrides',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'Grant a student an extension or extra attempts, with a reason',
  params: resourceParams,
  body: z.object({
    studentId: z.uuid(),
    extraAttempts: z.int().min(0).max(20),
    extraMinutes: z
      .int()
      .min(0)
      .max(7 * 24 * 60),
    closesAt: timestamp.nullable(),
    reason: z.string().trim().min(1).max(500),
  }),
  status: 201,
  response: grantedOverride,
  errors: { 400: invalidBody, 409: classArchived },
  examples: {
    params: { classId: exampleClass, resourceId: exampleResource },
    body: {
      studentId: exampleIds.cc,
      extraAttempts: 1,
      extraMinutes: 0,
      closesAt: null,
      reason: 'Medical note',
    },
  },
});

export const reviewedAttempt = attemptSummary.extend({
  student: z.object({ id: z.uuid(), name: z.string() }),
  /** The student has since been removed from the class; the work stays reviewable. */
  removed: z.boolean(),
  /** The IANA zone of the terms this attempt was taken under; times are shown in it. */
  timeZone: z.string(),
  graderVersion: z.string(),
});

/** Instructor: every student's attempts of a test in this class, newest attempt first. */
export const reviewTestAttempts = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/resources/:resourceId/test-attempts',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'Students’ attempts of a test with their state, receipt and pinned revision',
  params: resourceParams,
  response: z.object({ attempts: z.array(reviewedAttempt) }),
  examples: { params: { classId: exampleClass, resourceId: exampleResource } },
});

/**
 * Instructor: one attempt with the revision it was taken on (questions, answer keys, checks and
 * rubric as they were), its submitted answers and any kept local copy.
 */
export const reviewTestAttempt = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/test-attempts/:attemptId/review',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'One student’s attempt with its pinned test revision, answers and receipt',
  params: attemptParams,
  response: reviewedAttempt.extend({
    terms: effectiveTerms,
    /** The `test.v1` content of the pinned revision. */
    test: z.record(z.string(), z.unknown()),
    answers: z.array(answerAck.extend({ value: z.unknown(), flagged: z.boolean() })),
    localCopy: z.array(z.object({ questionId, value: z.unknown() })).nullable(),
  }),
  examples: { params: { classId: exampleClass, attemptId: exampleAttempt } },
});

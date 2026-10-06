import { cancelRun, latestRun, readRun, requestRun } from '@parallax/contracts/routes/runs';
import {
  keepLocalCopy,
  readTest,
  readTestAttempt,
  requestRecovery,
  reviewTestAttempt,
  reviewTestAttempts,
  saveTestAnswer,
  startTestAttempt,
  submitTestAttempt,
} from '@parallax/contracts/routes/tests';
import { useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import { ApiError, call, useApi } from '../api/client';

export type TestOverview = z.output<typeof readTest.response>;
export type AttemptView = z.output<typeof startTestAttempt.response>;
export type Receipt = z.output<typeof submitTestAttempt.response>;
export type Terms = AttemptView['terms'];
export type Question = AttemptView['questions'][number];
export type CodeQuestionView = Extract<Question, { kind: 'code' }>;
export type RunView = z.output<typeof requestRun.response>;
export type StudentRunView = Omit<RunView, 'reused'>;

export const useTestOverview = (classId: string, resourceId: string) =>
  useApi(readTest, { params: { classId, resourceId } });

export const startAttempt = (classId: string, resourceId: string) =>
  call(startTestAttempt, { params: { classId, resourceId } });

export const attemptKey = (classId: string, attemptId: string) => [
  'test-attempt',
  classId,
  attemptId,
];

/** The server's state of an attempt, settled first if its deadline has passed. */
export const fetchAttempt = (classId: string, attemptId: string) =>
  call(readTestAttempt, { params: { classId, attemptId } });

export const saveAnswer = (
  classId: string,
  attemptId: string,
  questionId: string,
  body: { value: unknown; flagged: boolean; seq: number },
) => call(saveTestAnswer, { params: { classId, attemptId, questionId }, body });

export const submitAttempt = (classId: string, attemptId: string, submissionKey: string) =>
  call(submitTestAttempt, { params: { classId, attemptId }, body: { submissionKey } });

export const sendLocalCopy = (
  classId: string,
  attemptId: string,
  answers: { questionId: string; value: unknown }[],
) => call(keepLocalCopy, { params: { classId, attemptId }, body: { answers } });

export const startRun = (
  classId: string,
  attemptId: string,
  questionId: string,
  files: { path: string; content: string }[],
) => call(requestRun, { params: { classId, attemptId, questionId }, body: { files } });

export const fetchRun = (classId: string, attemptId: string, runId: string) =>
  call(readRun, { params: { classId, attemptId, runId } });

export const fetchLatestRun = (classId: string, attemptId: string, questionId: string) =>
  call(latestRun, { params: { classId, attemptId, questionId }, query: { latest: '1' } });

export const cancelQueuedRun = (classId: string, attemptId: string, runId: string) =>
  call(cancelRun, { params: { classId, attemptId, runId } });

/** A student only ever receives the student shape; instructors' fields are not read here. */
export const asStudentRun = (run: unknown): StudentRunView => run as StudentRunView;

/** The `409` bodies that mean the attempt no longer takes answers. */
export function closedReceipt(error: unknown): { closed: true; receipt: Receipt | null } | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const body = error.body as { error?: unknown; receipt?: Receipt | null } | null;
  if (body?.error === 'attempt_closed' || body?.error === 'already_submitted') {
    return { closed: true, receipt: body.receipt ?? null };
  }
  return null;
}

export const useReviewedAttempts = (classId: string, resourceId: string) =>
  useApi(reviewTestAttempts, { params: { classId, resourceId } });

export const useReviewedAttempt = (classId: string, attemptId: string, enabled: boolean) =>
  useQuery({
    queryKey: ['review-attempt', classId, attemptId],
    queryFn: () => call(reviewTestAttempt, { params: { classId, attemptId } }),
    enabled,
  });

export const askForRecovery = (classId: string, attemptId: string, reason: string) =>
  call(requestRecovery, { params: { classId, attemptId }, body: { reason } });

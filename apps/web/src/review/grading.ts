import { reviewExercise } from '@parallax/contracts/routes/exercises';
import {
  type attemptGrade,
  type FeedbackItem,
  type gradeView,
  type ManualMark,
  overrideGrade,
  previewGradeRelease,
  readAttemptGrade,
  readTestGrades,
  regradeAttempt,
  releaseGrades,
  saveDraftGrade,
} from '@parallax/contracts/routes/grades';
import {
  getSubmissionDownload,
  getSubmissionFileDownload,
  reviewSubmissions,
} from '@parallax/contracts/routes/notebookSubmissions';
import { getClassReview, getStudentDiscussions } from '@parallax/contracts/routes/review';
import { attemptResults, type InstructorRun } from '@parallax/contracts/routes/runs';
import { reviewTestAttempt } from '@parallax/contracts/routes/tests';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { ApiError, call } from '../api/client';

export type AttemptGrade = z.output<typeof attemptGrade>;
export type GradeRow = z.output<typeof gradeView>;
export type TestGrades = z.output<typeof readTestGrades.response>;
export type ReleasePreview = z.output<typeof previewGradeRelease.response>;
export type ReviewedAttempt = z.output<typeof reviewTestAttempt.response>;
export type Discussions = z.output<typeof getStudentDiscussions.response>['discussions'];
export type { FeedbackItem, InstructorRun, ManualMark };

export const useTestGrades = (classId: string, resourceId: string | undefined) =>
  useQuery({
    queryKey: ['grading', 'test', classId, resourceId],
    queryFn: () => call(readTestGrades, { params: { classId, resourceId: resourceId ?? '' } }),
    enabled: resourceId !== undefined,
  });

export const useAttemptGrade = (classId: string, attemptId: string) =>
  useQuery({
    queryKey: ['grading', 'grade', classId, attemptId],
    queryFn: () => call(readAttemptGrade, { params: { classId, attemptId } }),
  });

export const useReviewedAttempt = (classId: string, attemptId: string) =>
  useQuery({
    queryKey: ['grading', 'attempt', classId, attemptId],
    queryFn: () => call(reviewTestAttempt, { params: { classId, attemptId } }),
  });

export const useAttemptRuns = (classId: string, attemptId: string) =>
  useQuery({
    queryKey: ['grading', 'runs', classId, attemptId],
    queryFn: () => call(attemptResults, { params: { classId, attemptId } }),
  });

export const useDiscussions = (classId: string, studentId: string) =>
  useQuery({
    queryKey: ['grading', 'discussions', classId, studentId],
    queryFn: () => call(getStudentDiscussions, { params: { classId, studentId } }),
  });

export type ExerciseAttempts = z.output<typeof reviewExercise.response>['attempts'];

export const useExerciseAttempts = (classId: string, exerciseId: string) =>
  useQuery({
    queryKey: ['grading', 'exercise', classId, exerciseId],
    queryFn: () => call(reviewExercise, { params: { classId, resourceId: exerciseId } }),
  });

export const useStudentSubmissions = (classId: string, notebookId: string) =>
  useQuery({
    queryKey: ['grading', 'submissions', classId, notebookId],
    queryFn: () => call(reviewSubmissions, { params: { classId, resourceId: notebookId } }),
  });

export const downloadLink = (classId: string, submissionId: string, fileId?: string) =>
  fileId
    ? call(getSubmissionFileDownload, { params: { classId, submissionId, fileId } })
    : call(getSubmissionDownload, { params: { classId, submissionId } });

/** A grade changed: the workspace, the class table and every list of grades read it again. */
export function useRefreshGrades(classId: string) {
  const client = useQueryClient();
  // Only this class's grade reads: not discussions, submissions or other classes' queries.
  const gradeKinds = ['test', 'grade', 'attempt', 'runs'];
  return () =>
    Promise.all([
      client.invalidateQueries({
        predicate: ({ queryKey: [root, kind, id] }) =>
          root === 'grading' && id === classId && gradeKinds.includes(String(kind)),
      }),
      client.invalidateQueries({ queryKey: ['GET', getClassReview.path, classId] }),
    ]);
}

export const saveDraft = (
  classId: string,
  attemptId: string,
  body: { expectedGradeId: string | null; manual: ManualMark[]; feedback: FeedbackItem[] },
) => call(saveDraftGrade, { params: { classId, attemptId }, body });

export const overridePoints = (
  classId: string,
  attemptId: string,
  body: { expectedGradeId: string; points: number; reason: string },
) => call(overrideGrade, { params: { classId, attemptId }, body });

export const regrade = (
  classId: string,
  attemptId: string,
  body: { expectedGradeId: string; reason: string },
) => call(regradeAttempt, { params: { classId, attemptId }, body });

export const previewRelease = (classId: string, attemptIds: string[]) =>
  call(previewGradeRelease, { params: { classId }, body: { attemptIds } });

export const release = (classId: string, grades: { attemptId: string; gradeId: string }[]) =>
  call(releaseGrades, { params: { classId }, body: { grades } });

/** What the server answered a conflicting change with: the grade as it now stands. */
export function conflictGrade(error: unknown): AttemptGrade | 'archived' | 'open' | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const body = error.body as { error?: string; current?: AttemptGrade } | null;
  if (body?.error === 'class_archived') return 'archived';
  if (body?.error === 'attempt_open') return 'open';
  return body?.current ?? null;
}

const STAMP = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});
export const stamp = (iso: string) => STAMP.format(new Date(iso));

export const points = (n: number) => String(Math.round(n * 100) / 100);

export const SOURCE_LABEL: Record<GradeRow['source'], string> = {
  draft: 'Saved grade',
  regrade: 'Regrade',
  override: 'Override',
};

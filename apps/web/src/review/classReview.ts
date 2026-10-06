import { getClassReview } from '@parallax/contracts/routes/review';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import { call } from '../api/client';

export type ClassReview = z.output<typeof getClassReview.response>;
export type ReviewRow = ClassReview['rows'][number];

/** The review table's state, kept in the address so a reload or a shared link reopens it. */
export interface ReviewSearch {
  topic?: string;
  assignment?: string;
  student?: string;
  needsReview?: true;
  /** The student whose work is open, beside the previous/next controls. */
  selected?: string;
  attempt?: string;
  /** The student view's tab; Results when absent. */
  tab?: ReviewTab;
  page?: number;
}

export type ReviewTab = 'results' | 'submissions' | 'comments';
const TABS: readonly string[] = ['results', 'submissions', 'comments'];

const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);

export function parseReviewSearch(search: Record<string, unknown>): ReviewSearch {
  const page = Number(search.page);
  return {
    topic: text(search.topic),
    assignment: text(search.assignment),
    student: text(search.student),
    needsReview: search.needsReview === true || search.needsReview === 'true' ? true : undefined,
    selected: text(search.selected),
    attempt: text(search.attempt),
    tab:
      TABS.includes(search.tab as string) && search.tab !== 'results'
        ? (search.tab as ReviewTab)
        : undefined,
    page: Number.isInteger(page) && page > 1 ? page : undefined,
  };
}

export const useClassReview = (classId: string, search: ReviewSearch) =>
  useQuery({
    queryKey: [
      'GET',
      getClassReview.path,
      classId,
      // Only what the server reads: picking a student is client state and refetches nothing.
      search.topic,
      search.assignment,
      search.student,
      search.needsReview,
      search.page,
      // The open attempt is asked for so `selected` describes it, not the newest attempt.
      search.attempt,
    ],
    queryFn: () =>
      call(getClassReview, {
        params: { classId },
        query: {
          topicId: search.topic,
          assignmentId: search.assignment,
          studentId: search.student,
          needsReview: search.needsReview ? true : undefined,
          attemptId: search.attempt,
          page: search.page,
        },
      }),
    placeholderData: keepPreviousData,
  });

const ATTEMPT_STATE: Record<NonNullable<ReviewRow['attempt']>['state'], string> = {
  in_progress: 'In progress',
  submitted: 'Submitted',
  grading: 'Grading',
  needs_review: 'Needs review',
  graded: 'Graded',
  released: 'Released',
};

/** The Test column: the selected assignment's newest attempt and score, else counts in scope. */
export function testText(row: ReviewRow, assignment: boolean): string {
  if (assignment) {
    const a = row.attempt;
    if (!a) return 'Not started';
    const score = a.score
      ? ` · ${a.score.points} / ${a.score.possible} ${a.score.state === 'released' ? 'released' : 'draft'}`
      : '';
    const waiting = a.unreleasedChange ? ' · unreleased change' : '';
    return `Attempt ${a.number} · ${ATTEMPT_STATE[a.state]}${score}${waiting}`;
  }
  if (row.tests.total === 0) return '—';
  return `${row.tests.submitted} of ${row.tests.total} submitted`;
}

export const exercisesText = (row: ReviewRow) =>
  row.exercises.total === 0 ? '—' : `${row.exercises.completed} of ${row.exercises.total}`;

export const reviewText = (row: ReviewRow) =>
  row.needsReview ? 'Needs review' : row.tests.submitted > 0 ? 'Reviewed' : '—';

/** An attempt whose newest grade is an unreleased draft: the table can offer it for release. */
export const releasable = (row: ReviewRow) =>
  row.attempt !== null &&
  row.attempt.score !== null &&
  (row.attempt.score.state === 'draft' || row.attempt.unreleasedChange);

/** A submission time in the viewer's own zone, named so it is never implicit (§14). */
export const submittedText = (row: ReviewRow) =>
  row.lastSubmission
    ? new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(new Date(row.lastSubmission.at))
    : '—';

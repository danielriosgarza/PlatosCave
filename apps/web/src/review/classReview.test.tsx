import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLASS_A,
  CLASS_B,
  instructorIn,
  makeMe,
  renderApp,
  signedIn,
  stubApi,
  studentIn,
} from '../test/render';
import type { ClassReview } from './classReview';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TOPIC = id(301);
const QUIZ = id(402);
const BEA = id(5);
const PRIYA = id(3);
const SAM = id(4);

const row = (studentId: string, name: string, over: Partial<ClassReview['rows'][number]> = {}) => ({
  studentId,
  name,
  exercises: { completed: 0, total: 0 },
  tests: { submitted: 1, released: 0, total: 1 },
  attempt: null,
  needsReview: false,
  openQuestions: 0,
  lastSubmission: null,
  ...over,
});
const awaiting = (n: number) =>
  ({
    attemptId: id(900 + n),
    number: 1,
    state: 'graded' as const,
    submittedAt: '2026-10-02T10:00:00.000Z',
    score: { points: 11, possible: 13, state: 'draft' as const },
    unreleasedChange: false,
    newestGradeId: id(1000 + n),
  }) satisfies NonNullable<ClassReview['rows'][number]['attempt']>;

const listed = (rows: ClassReview['rows']): ClassReview['students'] =>
  rows.map((r) => ({
    id: r.studentId,
    name: r.name,
    attempt: r.attempt && { attemptId: r.attempt.attemptId, number: r.attempt.number },
  }));

const roster = [
  { id: BEA, name: 'Bea Lindqvist' },
  { id: PRIYA, name: 'Priya Nair' },
  { id: SAM, name: 'Sam Okafor' },
];

function review(over: Partial<ClassReview> = {}): ClassReview {
  const rows = [
    row(BEA, 'Bea Lindqvist', { tests: { submitted: 0, released: 0, total: 1 } }),
    row(PRIYA, 'Priya Nair', { needsReview: true, attempt: awaiting(1), openQuestions: 2 }),
    row(SAM, 'Sam Okafor', { needsReview: true, attempt: awaiting(2) }),
  ];
  return {
    topics: [{ topicId: TOPIC, number: 1, title: 'Sampling' }],
    assignments: [{ assignmentId: QUIZ, title: 'Spread check', topicId: TOPIC }],
    notebooks: [],
    exercises: [],
    roster,
    students: listed(rows),
    total: 3,
    page: 1,
    pageSize: 25,
    rows,
    assignment: { assignmentId: QUIZ, title: 'Spread check' },
    selected: null,
    ...over,
  };
}

/** Serves the review as the server filters it: Needs review keeps the two awaiting students. */
function serve(onReview: (url: URL) => ClassReview) {
  const me = makeMe({ classes: [instructorIn(CLASS_A, 'Autumn 2026 A')] });
  const requests: URL[] = [];
  stubApi((url, init) => {
    const u = new URL(url, 'http://app.test');
    if (u.pathname === `/api/classes/${CLASS_A}/review`) {
      requests.push(u);
      return { status: 200, body: onReview(u) };
    }
    return signedIn(me)(url, init);
  });
  return requests;
}

const needsOnly = (u: URL): ClassReview => {
  const all = review();
  if (u.searchParams.get('needsReview') !== 'true') return all;
  const rows = all.rows.filter((r) => r.needsReview);
  return { ...all, rows, students: listed(rows), total: 2 };
};

describe('class review table', () => {
  it('A25 lists each student with exercises, test, questions and review state', async () => {
    serve(() => review());
    renderApp(`/classes/${CLASS_A}/review?assignment=${QUIZ}`);
    const table = await screen.findByRole('table');
    const priya = within(table).getByRole('button', { name: 'Priya Nair' }).closest('tr');
    expect(priya).toHaveTextContent('Attempt 1 · Graded · 11 / 13 draft');
    expect(priya).toHaveTextContent('Needs review');
    expect(
      within(table).getByRole('button', { name: 'Bea Lindqvist' }).closest('tr'),
    ).toHaveTextContent('—');
    // With an assignment chosen the table offers a selection column for releasing feedback.
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Release',
      'Student',
      'Exercises',
      'Test',
      'Questions',
      'Last submitted',
      'Review',
    ]);
  });

  it('A25 with Needs review active previous/next stays inside that filter and keeps the assignment visible', async () => {
    const user = userEvent.setup();
    const requests = serve(needsOnly);
    renderApp(
      `/classes/${CLASS_A}/review?needsReview=true&assignment=${QUIZ}&selected=${PRIYA}&attempt=${id(901)}`,
    );
    const selection = await screen.findByRole('region', { name: 'Selected student' });
    expect(within(selection).getByRole('heading', { name: 'Priya Nair' })).toBeVisible();
    expect(selection).toHaveTextContent('Test · Spread check');
    expect(selection).toHaveTextContent('Student 1 of 2');
    expect(within(selection).getByRole('button', { name: 'Previous student' })).toBeDisabled();

    await user.click(within(selection).getByRole('button', { name: 'Next student' }));
    const next = await screen.findByRole('heading', { name: 'Sam Okafor' });
    expect(next.closest('section')).toHaveTextContent('Test · Spread check');
    expect(next.closest('section')).toHaveTextContent('Student 2 of 2');
    // Bea is not in the filter, so Next stops at the end of the filtered list.
    expect(screen.getByRole('button', { name: 'Next student' })).toBeDisabled();
    expect(screen.queryByRole('heading', { name: 'Bea Lindqvist' })).toBeNull();
    expect(requests.every((r) => r.searchParams.get('needsReview') === 'true')).toBe(true);
  });

  it('A25 with no student left in Needs review the empty state offers Show all students, with every released grade retained', async () => {
    const user = userEvent.setup();
    const released = (n: number) =>
      ({
        ...awaiting(n),
        state: 'released' as const,
        score: { points: 13, possible: 13, state: 'released' as const },
        unreleasedChange: false,
      }) satisfies NonNullable<ClassReview['rows'][number]['attempt']>;
    serve((u) => {
      const rows = [
        row(PRIYA, 'Priya Nair', { attempt: released(1) }),
        row(SAM, 'Sam Okafor', { attempt: released(2) }),
      ];
      return u.searchParams.get('needsReview') === 'true'
        ? review({ rows: [], students: [], total: 0 })
        : review({
            rows,
            students: listed(rows),
            total: 2,
          });
    });
    renderApp(`/classes/${CLASS_A}/review?needsReview=true&assignment=${QUIZ}`);
    expect(await screen.findByRole('heading', { name: 'No students need review.' })).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Show all students' }));
    const table = await screen.findByRole('table');
    expect(within(table).getAllByText(/Attempt 1 · Released · 13 \/ 13 released/)).toHaveLength(2);
    expect(screen.getByLabelText('Status')).toHaveValue('all');
  });

  it('A25 paginates the table while previous/next follows the whole list', async () => {
    const user = userEvent.setup();
    const all = review();
    serve((u) => {
      const page = Number(u.searchParams.get('page') ?? 1);
      return { ...all, page, pageSize: 2, rows: all.rows.slice((page - 1) * 2, page * 2) };
    });
    renderApp(`/classes/${CLASS_A}/review?selected=${PRIYA}`);
    expect(await screen.findByText('Page 1 of 2 · 3 students')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Page 2 of 2 · 3 students')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Sam Okafor' })).toBeVisible();
    // The selected student stays reachable from the other page through the whole list.
    expect(screen.getByRole('button', { name: 'Previous student' })).toBeEnabled();
  });

  it('A25 Next student across a page boundary moves to that page and keeps the attempt visible', async () => {
    const user = userEvent.setup();
    const all = review();
    const requests = serve((u) => {
      const page = Number(u.searchParams.get('page') ?? 1);
      return { ...all, page, pageSize: 2, rows: all.rows.slice((page - 1) * 2, page * 2) };
    });
    renderApp(`/classes/${CLASS_A}/review?assignment=${QUIZ}&selected=${PRIYA}`);
    const selection = await screen.findByRole('region', { name: 'Selected student' });
    expect(selection).toHaveTextContent('Attempt 1');
    await user.click(within(selection).getByRole('button', { name: 'Next student' }));
    expect(await screen.findByRole('heading', { name: 'Sam Okafor' })).toBeVisible();
    const after = screen.getByRole('region', { name: 'Selected student' });
    expect(after).toHaveTextContent('Test · Spread check · Attempt 1 · Student 3 of 3');
    // Sam's row is on screen: the table followed him to page 2.
    expect(await screen.findByRole('button', { name: 'Sam Okafor', current: true })).toBeVisible();
    expect(requests.at(-1)?.searchParams.get('page')).toBe('2');
  });

  it('A25 a filter change keeps the selected student while they stay in the list, and the open attempt is asked for', async () => {
    const user = userEvent.setup();
    const requests = serve(() => review());
    renderApp(`/classes/${CLASS_A}/review?selected=${PRIYA}`);
    await screen.findByRole('region', { name: 'Selected student' });
    await user.click(screen.getByRole('button', { name: 'Sam Okafor' }));
    await screen.findByRole('heading', { name: 'Sam Okafor' });
    // The open attempt goes to the server so `selected` describes it, not the newest attempt.
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests.at(-1)?.searchParams.get('attemptId')).toBe(id(902));
    await user.selectOptions(screen.getByLabelText('Assignment'), QUIZ);
    expect(await screen.findByRole('heading', { name: 'Sam Okafor' })).toBeVisible();
    await waitFor(() => expect(requests).toHaveLength(3));
  });

  it('A25 a student of the class is shown nothing of the review', async () => {
    stubApi(signedIn(makeMe({ classes: [studentIn(CLASS_B, 'Autumn 2026 B')] })));
    renderApp(`/classes/${CLASS_B}/review`);
    expect(
      await screen.findByRole('heading', { name: 'This page is not available' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

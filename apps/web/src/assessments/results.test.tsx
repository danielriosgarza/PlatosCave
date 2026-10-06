import '@testing-library/jest-dom/vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLASS_A,
  makeMe,
  makeTopics,
  renderApp,
  stubApi,
  studentIn,
  T_SAMPLING,
} from '../test/render';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RESOURCE = uuid(0xa1);
const base = `/api/classes/${CLASS_A}`;
const CODE = 'def mean(xs):\n    return 2\n';

const terms = {
  attempts: 5,
  durationMinutes: null,
  opensAt: null,
  closesAt: null,
  timeZone: 'Europe/Madrid',
  late: { policy: 'none' },
  release: { results: 'manual', at: null, solutions: 'never', hiddenTestDetails: false },
  reportedGrade: 'latest',
  allowedMaterials: '',
  override: null,
  totalPoints: 10,
};

/** An attempt as the overview lists it and as the results route reports it. */
const attempt = (n: number, state: string, status: string, grade: unknown = null) => ({
  summary: {
    id: uuid(0xa00 + n),
    number: n,
    state: status === 'in_progress' ? 'in_progress' : state,
    resourceRevisionId: uuid(0xa3),
    startedAt: '2026-10-05T09:00:00Z',
    deadlineAt: null,
    submittedAt: status === 'in_progress' ? null : '2026-10-05T09:30:00Z',
    receipt: null,
    localCopyAt: null,
  },
  result: { attemptId: uuid(0xa00 + n), number: n, status, state, grade },
});

const released = (points: number, feedback: unknown[] = []) => ({
  gradeId: uuid(0xe1),
  points,
  possible: 10,
  overridden: false,
  questions: [
    {
      questionId: 'mean',
      possible: 6,
      points: Math.min(points, 6),
      automatedPoints: Math.min(points, 6),
      manualPoints: null,
      criteria: [],
    },
    {
      questionId: 'why',
      possible: 4,
      points: Math.max(points - 6, 0),
      automatedPoints: null,
      manualPoints: Math.max(points - 6, 0),
      criteria: [{ id: 'clear', points: Math.max(points - 6, 0) }],
    },
  ],
  feedback,
  releasedAt: '2026-10-06T09:00:00Z',
});

const detail = {
  attemptId: uuid(0xa01),
  gradeId: uuid(0xe1),
  solutionsShown: false,
  hiddenTestDetailsShown: false,
  questions: [
    {
      questionId: 'mean',
      kind: 'code',
      prompt: 'Implement mean(xs).',
      possible: 6,
      rubric: [],
      answer: { files: [{ path: 'solution.py', content: CODE }] },
      solution: null,
      code: {
        files: [{ path: 'solution.py', content: CODE }],
        checks: [{ name: 'sample', status: 'passed', visibility: 'public' }],
        checkTotals: { passed: 1, total: 2 },
      },
    },
    {
      questionId: 'why',
      kind: 'explanation',
      prompt: 'Explain why larger samples narrow the distribution.',
      possible: 4,
      rubric: [{ id: 'clear', label: 'Clear argument', points: 4 }],
      answer: 'Because noise averages out.',
      solution: null,
      code: null,
    },
  ],
};

function serve(attempts: ReturnType<typeof attempt>[], reported: unknown = null) {
  const me = makeMe({ classes: [studentIn(CLASS_A, 'Autumn 2026 A')] });
  stubApi((url) => {
    if (url === '/api/me') return { status: 200, body: me };
    if (/\/topics$/.test(url)) return { status: 200, body: makeTopics() };
    if (/\/reviews$/.test(url)) {
      return { status: 200, body: { topicId: T_SAMPLING, complete: false, items: [] } };
    }
    if (url === `${base}/release`) {
      return {
        status: 200,
        body: {
          release: { id: uuid(601), version: 1, createdAt: '2026-09-01T09:00:00Z' },
          topics: [
            {
              id: uuid(700),
              topicId: T_SAMPLING,
              position: 0,
              title: 'Sampling',
              objective: '',
              prerequisites: [],
              estimatedMinutes: null,
              resources: [
                {
                  id: uuid(701),
                  resourceId: RESOURCE,
                  revisionId: uuid(0xa3),
                  type: 'test',
                  tab: 'tests',
                  position: 0,
                  title: 'Sampling and uncertainty',
                  visibility: 'visible',
                  releaseAt: null,
                  credit: null,
                },
              ],
            },
          ],
        },
      };
    }
    if (url === `${base}/resources/${RESOURCE}/test`) {
      return {
        status: 200,
        body: {
          resourceId: RESOURCE,
          resourceRevisionId: uuid(0xa3),
          terms,
          questionCount: 2,
          attempts: attempts.map((a) => a.summary),
          eligibility: {
            canStart: true,
            reason: null,
            attemptsUsed: attempts.length,
            attemptsAllowed: 5,
          },
          serverNow: new Date().toISOString(),
        },
      };
    }
    if (url === `${base}/resources/${RESOURCE}/results`) {
      return {
        status: 200,
        body: { rule: 'latest', reported, attempts: attempts.map((a) => a.result) },
      };
    }
    if (url === `${base}/test-attempts/${uuid(0xa01)}/released`)
      return { status: 200, body: detail };
    return { status: 404, body: {} };
  });
}

const open = () => renderApp(`/classes/${CLASS_A}/topics/${T_SAMPLING}/tests`);

describe('student results view', () => {
  it('A20 a student finds released feedback: points, rubric, answer and the note on a code line', async () => {
    const user = userEvent.setup();
    serve(
      [
        attempt(
          1,
          'released',
          'released',
          released(8, [
            { target: { kind: 'attempt' }, text: 'Well argued overall.' },
            {
              target: { kind: 'line', questionId: 'mean', path: 'solution.py', line: 2 },
              text: 'Hard-coded value.',
            },
            { target: { kind: 'question', questionId: 'why' }, text: 'Name the law you rely on.' },
          ]),
        ),
      ],
      { attemptId: uuid(0xa01), gradeId: uuid(0xe1), points: 8, possible: 10 },
    );
    open();
    expect(
      await screen.findByText('Reported grade: 8 of 10 points (latest attempt)'),
    ).toBeVisible();
    expect(screen.getByText('Result: 8 of 10 points')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'View feedback for attempt 1' }));

    expect(
      await screen.findByRole('heading', { name: 'Sampling and uncertainty · attempt 1 feedback' }),
    ).toHaveFocus();
    expect(screen.getByText('8 of 10 points')).toBeVisible();
    expect(screen.getByText('Well argued overall.')).toBeVisible();
    expect(
      await screen.findByRole('heading', { name: 'Question 1 · 6 of 6 points' }),
    ).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Question 2 · 2 of 4 points' })).toBeVisible();
    expect(screen.getByText('Because noise averages out.')).toBeVisible();
    expect(screen.getByText('Clear argument: 2 of 4')).toBeVisible();
    expect(screen.getByText('Name the law you rely on.')).toBeVisible();

    // The note sits under line 2 of the student's file, not under line 1.
    const lines = within(
      screen.getByRole('list', { name: 'Your code in solution.py' }),
    ).getAllByRole('listitem');
    expect(within(lines[0] as HTMLElement).queryByText(/Hard-coded value/)).toBeNull();
    expect(within(lines[1] as HTMLElement).getByText(/Hard-coded value/)).toBeVisible();

    // Hidden checks are counted, not described, under the default release policy.
    expect(
      screen.getByText(/1 of 2 checks passed\. Details of the remaining checks/),
    ).toBeVisible();
    expect(screen.queryByText(/hidden-large/)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Back to attempts' }));
    expect(
      await screen.findByRole('button', { name: 'View feedback for attempt 1' }),
    ).toBeVisible();
  });

  it('A20 a score of zero, an unsubmitted attempt and a grading failure read differently', async () => {
    serve([
      attempt(1, 'released', 'released', released(0)),
      attempt(2, 'in_progress', 'in_progress'),
      attempt(3, 'needs_review', 'pending'),
      attempt(4, 'graded', 'pending'),
      attempt(5, 'grading', 'pending'),
    ]);
    open();
    const list = await screen.findByRole('list', { name: 'Your attempts' });
    const text = (n: number) => within(list).getAllByRole('listitem')[n - 1]?.textContent ?? '';
    expect(text(1)).toContain('Result: 0 of 10 points');
    expect(text(2)).toContain('Not submitted yet');
    expect(text(3)).toContain('Grading could not finish');
    expect(text(3)).toContain('no score has been recorded');
    expect(text(4)).toContain('has not released the result yet');
    expect(text(5)).toContain('Submitted · not graded yet');
    // Only the released attempt offers feedback to open.
    expect(within(list).getAllByRole('button')).toHaveLength(1);
  });
});

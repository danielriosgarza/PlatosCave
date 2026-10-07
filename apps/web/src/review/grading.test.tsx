import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLASS_A, instructorIn, makeMe, renderApp, signedIn, stubApi } from '../test/render';
import type { ClassReview } from './classReview';
import type { AttemptGrade, GradeRow } from './grading';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TOPIC = id(301);
const QUIZ = id(402);
const NOTEBOOK = id(403);
const READING = id(404);
const PRIYA = id(3);
const SAM = id(4);
const OLD = id(6);
const A_PRIYA = id(901);
const A_SAM = id(902);
const A_OLD = id(903);
const REVISION = id(950);
const NEWER_REVISION = id(951);
const NOW = '2026-10-02T10:00:00.000Z';

const SUMMARY = (attemptId: string, number = 1) => ({
  attemptId,
  number,
  state: 'graded' as const,
  submittedAt: NOW,
  score: { points: 5, possible: 5, state: 'draft' as const },
  unreleasedChange: false,
  gradeId: id(1001),
});

const row = (studentId: string, name: string, attemptId: string, over = {}) => ({
  studentId,
  name,
  exercises: { completed: 0, total: 0 },
  tests: { submitted: 1, released: 0, total: 1 },
  attempt: { ...SUMMARY(attemptId), ...over },
  needsReview: true,
  openQuestions: 0,
  lastSubmission: { at: NOW, kind: 'test' as const },
});

function review(
  rows = [row(PRIYA, 'Priya Nair', A_PRIYA), row(SAM, 'Sam Okafor', A_SAM)],
): ClassReview {
  return {
    topics: [{ topicId: TOPIC, number: 1, title: 'Sampling' }],
    assignments: [{ assignmentId: QUIZ, title: 'Spread check', topicId: TOPIC }],
    notebooks: [{ notebookId: NOTEBOOK, title: 'Sampling lab', topicId: TOPIC }],
    exercises: [],
    roster: [
      { id: PRIYA, name: 'Priya Nair' },
      { id: SAM, name: 'Sam Okafor' },
    ],
    students: rows.map((r) => ({
      id: r.studentId,
      name: r.name,
      attempt: r.attempt && { attemptId: r.attempt.attemptId, number: r.attempt.number },
    })),
    total: rows.length,
    page: 1,
    pageSize: 25,
    rows,
    assignment: { assignmentId: QUIZ, title: 'Spread check' },
    selected: null,
  };
}

const questionScores = (manual: number | null): AttemptGrade['automated'] => [
  {
    questionId: 'pick',
    possible: 2,
    automated: { possible: 2, points: 2, status: 'scored', resultId: null },
    manual: null,
    points: 2,
  },
  {
    questionId: 'why',
    possible: 3,
    automated: null,
    manual: {
      possible: 3,
      points: manual,
      criteria: manual === null ? [] : [{ id: 'averaging', points: manual }],
    },
    points: manual,
  },
];

function gradeRow(n: number, over: Partial<GradeRow> = {}): GradeRow {
  const manual = 3;
  return {
    id: id(1000 + n),
    attemptId: A_PRIYA,
    number: n,
    state: 'draft',
    source: 'draft',
    reason: null,
    resourceRevisionId: REVISION,
    graderVersion: 'grader-1',
    questions: questionScores(manual),
    feedback: [],
    automatedPoints: 2,
    manualPoints: manual,
    override: null,
    points: 5,
    possible: 5,
    complete: true,
    createdBy: id(1),
    createdAt: NOW,
    releaseId: null,
    releasedAt: null,
    ...over,
  };
}

const attemptGrade = (
  history: GradeRow[],
  studentId = PRIYA,
  attemptId = A_PRIYA,
): AttemptGrade => ({
  attemptId,
  attemptState: 'graded',
  student: { id: studentId, name: studentId === PRIYA ? 'Priya Nair' : 'Sam Okafor' },
  automated: questionScores(null),
  history,
  released: history.find((h) => h.state === 'released') ?? null,
});

const testContent = {
  schema: 'test.v1',
  questions: [
    {
      id: 'pick',
      kind: 'choice',
      prompt: 'Which sample mean varies least?',
      points: 2,
      options: [
        { id: 'n10', label: 'n = 10' },
        { id: 'n100', label: 'n = 100' },
      ],
    },
    {
      id: 'why',
      kind: 'explanation',
      prompt: 'Why does the larger sample vary less?',
      points: 3,
      rubric: [{ id: 'averaging', label: 'Names averaging out of noise', points: 3 }],
    },
  ],
};

const terms = {
  attempts: 1,
  durationMinutes: null,
  opensAt: null,
  closesAt: null,
  timeZone: 'Europe/Madrid',
  late: { policy: 'none' as const },
  release: {
    results: 'manual' as const,
    at: null,
    solutions: 'never' as const,
    hiddenTestDetails: false,
  },
  reportedGrade: 'latest' as const,
  allowedMaterials: '',
  override: null,
  totalPoints: 5,
};

const reviewedAttempt = (
  attemptId: string,
  student: { id: string; name: string },
  removed = false,
) => ({
  id: attemptId,
  number: 1,
  state: 'graded' as const,
  resourceRevisionId: REVISION,
  startedAt: NOW,
  deadlineAt: null,
  submittedAt: NOW,
  receipt: null,
  localCopyAt: null,
  recoveryRequestedAt: null,
  student,
  removed,
  graderVersion: 'grader-1',
  terms,
  test: testContent,
  answers: [
    { questionId: 'pick', seq: 1, savedAt: NOW, value: ['n100'], flagged: false },
    { questionId: 'why', seq: 1, savedAt: NOW, value: 'Noise averages out.', flagged: false },
  ],
  localCopy: null,
});

const testGrades = (over: { removed?: boolean } = {}) => ({
  rule: 'latest' as const,
  students: [
    {
      student: { id: PRIYA, name: 'Priya Nair' },
      removed: false,
      reported: null,
      selectedAttemptId: null,
      attempts: [
        {
          attemptId: A_PRIYA,
          number: 1,
          state: 'graded' as const,
          current: null,
          released: null,
        },
      ],
    },
    ...(over.removed
      ? [
          {
            student: { id: OLD, name: 'Olga Vance' },
            removed: true,
            reported: null,
            selectedAttemptId: null,
            attempts: [
              {
                attemptId: A_OLD,
                number: 1,
                state: 'submitted' as const,
                current: null,
                released: null,
              },
            ],
          },
        ]
      : []),
  ],
});

interface Calls {
  method: string;
  path: string;
  body: unknown;
}

/** Serves the endpoints the workspace reads and records every request. */
function serve(options: {
  history?: GradeRow[];
  withRemoved?: boolean;
  reviewData?: ClassReview;
  grades?: (calls: Calls[]) => unknown;
  extra?: (
    path: string,
    method: string,
    body: unknown,
    url: URL,
  ) => { status: number; body?: unknown } | undefined;
}) {
  const me = makeMe({ classes: [instructorIn(CLASS_A, 'Autumn 2026 A')] });
  const calls: Calls[] = [];
  let history = options.history ?? [];
  stubApi((url, init) => {
    const u = new URL(url, 'http://app.test');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = u.pathname.replace(`/api/classes/${CLASS_A}`, '');
    if (u.pathname.startsWith(`/api/classes/${CLASS_A}`)) calls.push({ method, path, body });
    const extra = options.extra?.(path, method, body, u);
    if (extra) return extra;
    if (path === '/review') return { status: 200, body: options.reviewData ?? review() };
    if (path === `/resources/${QUIZ}/grades`) {
      return { status: 200, body: testGrades({ removed: options.withRemoved }) };
    }
    const attempt = /^\/test-attempts\/([^/]+)(\/.*)?$/.exec(path);
    if (attempt) {
      const [, attemptId, rest = ''] = attempt;
      const student =
        attemptId === A_SAM
          ? { id: SAM, name: 'Sam Okafor' }
          : attemptId === A_OLD
            ? { id: OLD, name: 'Olga Vance' }
            : { id: PRIYA, name: 'Priya Nair' };
      if (rest === '/review' && method === 'GET') {
        return {
          status: 200,
          body: reviewedAttempt(attemptId ?? '', student, attemptId === A_OLD),
        };
      }
      if (rest === '/results') return { status: 200, body: { runs: [] } };
      if (rest === '/grade' && method === 'GET') {
        return { status: 200, body: attemptGrade(history, student.id, attemptId) };
      }
      if (rest === '/grade' && method === 'POST') {
        history = [gradeRow(history.length + 1), ...history];
        return { status: 200, body: attemptGrade(history) };
      }
      if (rest === '/grade/override' && method === 'POST') {
        const b = body as { points: number; reason: string };
        history = [
          gradeRow(history.length + 1, {
            source: 'override',
            reason: b.reason,
            points: b.points,
            override: {
              id: id(5000),
              points: b.points,
              reason: b.reason,
              priorGradeId: history[0]?.id ?? id(1),
              createdBy: id(1),
              createdAt: NOW,
            },
          }),
          ...history,
        ];
        return { status: 200, body: attemptGrade(history) };
      }
    }
    return signedIn(me)(url, init);
  });
  return calls;
}

describe('grading workspace', () => {
  it('A17 Save draft grade stores a draft the student cannot see, and Release feedback follows only a saved grade', async () => {
    const user = userEvent.setup({ delay: null });
    const calls = serve({});
    renderApp(`/classes/${CLASS_A}/review?assignment=${QUIZ}&selected=${PRIYA}&attempt=${A_PRIYA}`);
    const workspace = await screen.findByRole('region', { name: 'Grading workspace' });
    // The submitted work is on one side, rubric and feedback on the other; the cohort stays named.
    expect(workspace).toHaveTextContent('Autumn 2026 A · Spread check · Attempt 1');
    expect(within(workspace).getByText('Chosen: n = 100')).toBeVisible();
    expect(within(workspace).getByText('Noise averages out.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Release feedback' })).toBeDisabled();
    expect(screen.getByText('Save a grade first.')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Student cannot see draft feedback.');

    await user.type(screen.getByLabelText(/Names averaging out of noise/), '3');
    await user.type(screen.getByLabelText('Feedback to Priya Nair'), 'Well argued.');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Unsaved changes. Save the draft before releasing.',
    );
    await user.click(screen.getByRole('button', { name: 'Save draft grade' }));

    expect(await screen.findByText(/Draft saved\. The student cannot see it/)).toBeVisible();
    const saved = calls.find((c) => c.method === 'POST' && c.path.endsWith('/grade'));
    expect(saved?.body).toEqual({
      expectedGradeId: null,
      manual: [{ questionId: 'why', criteria: [{ id: 'averaging', points: 3 }] }],
      feedback: [{ target: { kind: 'attempt' }, text: 'Well argued.' }],
    });
    expect(calls.some((c) => c.path === '/grade-releases')).toBe(false);
    expect(await screen.findByRole('button', { name: 'Release feedback' })).toBeEnabled();
  });

  it('A17 Release feedback names the recipient and attempt first and releases exactly the previewed grade', async () => {
    const user = userEvent.setup({ delay: null });
    const draft = gradeRow(1);
    const preview = {
      recipients: [
        {
          student: { id: PRIYA, name: 'Priya Nair' },
          attemptId: A_PRIYA,
          attemptNumber: 1,
          resourceId: QUIZ,
          gradeId: draft.id,
          gradeNumber: 1,
          points: 5,
          possible: 5,
        },
      ],
      skipped: [],
    };
    const calls = serve({
      history: [draft],
      extra: (path, method) => {
        if (path === '/grade-releases/preview') return { status: 200, body: preview };
        if (path === '/grade-releases' && method === 'POST') {
          // The server updates the grade row in place: same id, now released.
          draft.state = 'released';
          draft.releasedAt = NOW;
          draft.releaseId = id(7000);
          return {
            status: 201,
            body: {
              id: id(7000),
              releasedBy: id(1),
              releasedAt: NOW,
              recipients: preview.recipients,
            },
          };
        }
        return undefined;
      },
    });
    renderApp(`/classes/${CLASS_A}/review?assignment=${QUIZ}&selected=${PRIYA}&attempt=${A_PRIYA}`);
    await screen.findByRole('region', { name: 'Grading workspace' });
    await user.click(await screen.findByRole('button', { name: 'Release feedback' }));
    const panel = await screen.findByRole('region', { name: 'Release preview' });
    expect(panel).toHaveTextContent('Release to Priya Nair');
    expect(panel).toHaveTextContent('Spread check · Attempt 1 · grade 1: 5 / 5');
    // Nothing is released by previewing.
    expect(calls.some((c) => c.method === 'POST' && c.path === '/grade-releases')).toBe(false);
    await user.click(within(panel).getByRole('button', { name: 'Confirm release to 1 student' }));
    expect(await screen.findByText(/Released to Priya Nair on/)).toBeVisible();
    expect(calls.find((c) => c.method === 'POST' && c.path === '/grade-releases')?.body).toEqual({
      grades: [{ attemptId: A_PRIYA, gradeId: draft.id }],
    });
    // The workspace shows the released state, not the draft it started from.
    const workspace = screen.getByRole('region', { name: 'Grading workspace' });
    await waitFor(() => expect(workspace).toHaveTextContent('Released to Priya Nair: 5 / 5'));
    expect(workspace).toHaveTextContent('Rubric / released feedback');
    expect(within(workspace).getByRole('button', { name: 'Feedback released' })).toBeDisabled();
  });

  it('A17 an override asks for a reason, and the history keeps the grade it replaced', async () => {
    const user = userEvent.setup({ delay: null });
    const calls = serve({ history: [gradeRow(1)] });
    renderApp(`/classes/${CLASS_A}/review?assignment=${QUIZ}&selected=${PRIYA}&attempt=${A_PRIYA}`);
    await screen.findByRole('region', { name: 'Grading workspace' });
    await user.click(screen.getByRole('button', { name: 'Override grade' }));
    const form = screen.getByRole('form', { name: 'Override grade' });
    await user.type(within(form).getByLabelText(/Points of 5/), '4');
    await user.type(within(form).getByLabelText('Reason'), 'Check misjudged a correct answer');
    await user.click(within(form).getByRole('button', { name: 'Save override as draft' }));
    await user.click(await screen.findByText(/Grade history \(2\)/));
    const history = screen.getByRole('list', { name: 'Grade history' });
    expect(within(history).getAllByRole('listitem')).toHaveLength(2);
    expect(history).toHaveTextContent('Grade 2 · Override · 4 / 5');
    expect(history).toHaveTextContent('Grade 1 · Saved grade · 5 / 5');
    expect(calls.find((c) => c.path.endsWith('/grade/override'))?.body).toEqual({
      expectedGradeId: gradeRow(1).id,
      points: 4,
      reason: 'Check misjudged a correct answer',
    });
  });

  it('A25 a draft saved after release shows the released grade apart from the unreleased draft', async () => {
    const released = gradeRow(1, { state: 'released', releasedAt: NOW, releaseId: id(7000) });
    const regraded = gradeRow(2, {
      source: 'regrade',
      reason: 'Replayed after the outage',
      points: 4,
    });
    serve({
      history: [regraded, released],
      reviewData: review([
        row(PRIYA, 'Priya Nair', A_PRIYA, {
          state: 'released',
          score: { points: 5, possible: 5, state: 'released' },
          unreleasedChange: true,
        }),
      ]),
    });
    renderApp(`/classes/${CLASS_A}/review?assignment=${QUIZ}&selected=${PRIYA}&attempt=${A_PRIYA}`);
    const table = await screen.findByRole('table');
    const priya = within(table).getByRole('button', { name: 'Priya Nair' }).closest('tr');
    expect(priya).toHaveTextContent('5 / 5 released · unreleased change');
    expect(priya).toHaveTextContent('Needs review');
    const workspace = await screen.findByRole('region', { name: 'Grading workspace' });
    expect(workspace).toHaveTextContent('Released to Priya Nair: 5 / 5');
    expect(workspace).toHaveTextContent(
      'A newer regrade (4 / 5) is a draft the student does not see',
    );
    expect(within(workspace).getByRole('button', { name: 'Release feedback' })).toBeEnabled();
  });

  it('A25 bulk release previews the exact students and results, and names who is skipped', async () => {
    const user = userEvent.setup({ delay: null });
    const preview = {
      recipients: [
        {
          student: { id: PRIYA, name: 'Priya Nair' },
          attemptId: A_PRIYA,
          attemptNumber: 1,
          resourceId: QUIZ,
          gradeId: id(1001),
          gradeNumber: 1,
          points: 5,
          possible: 5,
        },
      ],
      skipped: [{ attemptId: A_SAM, reason: 'incomplete' as const }],
    };
    const calls = serve({
      extra: (path, method) => {
        if (path === '/grade-releases/preview') return { status: 200, body: preview };
        if (path === '/grade-releases' && method === 'POST') {
          return {
            status: 201,
            body: {
              id: id(7001),
              releasedBy: id(1),
              releasedAt: NOW,
              recipients: preview.recipients,
            },
          };
        }
        return undefined;
      },
    });
    renderApp(`/classes/${CLASS_A}/review?assignment=${QUIZ}`);
    await screen.findByRole('table');
    expect(screen.getByRole('button', { name: 'Preview release (0)' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Select Priya Nair for release' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Sam Okafor for release' }));
    await user.click(screen.getByRole('button', { name: 'Preview release (2)' }));
    const panel = await screen.findByRole('region', { name: 'Release preview' });
    expect(calls.find((c) => c.path === '/grade-releases/preview')?.body).toEqual({
      attemptIds: [A_PRIYA, A_SAM],
    });
    expect(within(panel).getByRole('list', { name: 'Recipients' })).toHaveTextContent(
      'Priya Nair · Attempt 1 · 5 / 5',
    );
    expect(within(panel).getByRole('list', { name: 'Skipped' })).toHaveTextContent(
      'Sam Okafor: some questions have no points',
    );
    expect(calls.some((c) => c.method === 'POST' && c.path === '/grade-releases')).toBe(false);
    await user.click(within(panel).getByRole('button', { name: 'Confirm release to 1 student' }));
    expect(await screen.findByText(/Released to 1 student on/)).toBeVisible();
    expect(calls.find((c) => c.method === 'POST' && c.path === '/grade-releases')?.body).toEqual({
      grades: [{ attemptId: A_PRIYA, gradeId: id(1001) }],
    });
  });

  it('A25 a removed student’s submitted attempt stays reachable although the table does not list them', async () => {
    const user = userEvent.setup({ delay: null });
    serve({ withRemoved: true });
    renderApp(`/classes/${CLASS_A}/review?assignment=${QUIZ}`);
    const table = await screen.findByRole('table');
    expect(within(table).queryByText('Olga Vance')).toBeNull();
    const removed = await screen.findByRole('region', { name: 'Removed students' });
    await user.click(within(removed).getByRole('button', { name: 'Olga Vance · Attempt 1' }));
    expect(await screen.findByRole('heading', { name: 'Olga Vance' })).toBeVisible();
    expect(await screen.findByRole('region', { name: 'Grading workspace' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Selected student' })).toHaveTextContent(
      'Removed from the class',
    );
  });

  it('A25 the attempt that is open stays visible beside the student, whatever the newest attempt is', async () => {
    const data = review();
    serve({
      reviewData: {
        ...data,
        selected: {
          studentId: PRIYA,
          studentName: 'Priya Nair',
          attemptId: A_PRIYA,
          number: 2,
          assignmentId: QUIZ,
        },
      },
    });
    renderApp(`/classes/${CLASS_A}/review?assignment=${QUIZ}&selected=${PRIYA}&attempt=${A_PRIYA}`);
    const selection = await screen.findByRole('region', { name: 'Selected student' });
    expect(selection).toHaveTextContent('Test · Spread check · Attempt 2 · Student 1 of 2');
  });

  it('A35 the Submissions tab shows a snapshot from a personal computer and contacts no computer to open it', async () => {
    const user = userEvent.setup({ delay: null });
    const calls = serve({
      extra: (path) => {
        if (path === `/resources/${NOTEBOOK}/notebook-submissions`) {
          return {
            status: 200,
            body: {
              submissions: [
                {
                  id: id(8001),
                  resourceId: NOTEBOOK,
                  resourceRevisionId: REVISION,
                  version: 2,
                  filename: 'lab.ipynb',
                  size: 4096,
                  sha256: 'a'.repeat(64),
                  environment: { runtime: 'local', kernel: 'python3' },
                  receivedAt: NOW,
                  workingCopyRevision: 7,
                  files: [
                    { id: id(8002), path: 'data/results.csv', size: 120, sha256: 'b'.repeat(64) },
                  ],
                  student: { id: PRIYA, name: 'Priya Nair' },
                  removed: false,
                },
                {
                  id: id(8003),
                  resourceId: NOTEBOOK,
                  resourceRevisionId: REVISION,
                  version: 1,
                  filename: 'someone-else.ipynb',
                  size: 100,
                  sha256: 'c'.repeat(64),
                  environment: {},
                  receivedAt: NOW,
                  student: { id: SAM, name: 'Sam Okafor' },
                  removed: false,
                },
              ],
            },
          };
        }
        if (path.endsWith('/download')) {
          return { status: 200, body: { url: 'https://content.example.test/x', expiresAt: NOW } };
        }
        return undefined;
      },
    });
    renderApp(`/classes/${CLASS_A}/review?assignment=${QUIZ}&selected=${PRIYA}&tab=submissions`);
    const notebook = await screen.findByRole('region', { name: 'Notebook · Sampling lab' });
    expect(await within(notebook).findByText(/Version 2 · lab\.ipynb/)).toBeVisible();
    expect(notebook).toHaveTextContent(
      'Declared by the file, not verified: runtime local · kernel python3',
    );
    expect(notebook).toHaveTextContent('Frozen from the saved working copy, revision 7');
    expect(notebook).not.toHaveTextContent('someone-else.ipynb');
    await user.click(within(notebook).getByRole('button', { name: 'Download data/results.csv' }));
    await waitFor(() =>
      expect(calls.some((c) => c.path.endsWith(`/files/${id(8002)}/download`))).toBe(true),
    );
    // Reading a snapshot is a Parallax read: no connector or connection route is touched.
    expect(calls.filter((c) => /connector|connection|session/.test(c.path))).toEqual([]);
    // Nothing offers to connect to the student's computer.
    expect(screen.queryByRole('button', { name: /connect/i })).toBeNull();
  });

  it('A08 the Exercises tab shows hints, solution use and answers distinctly, for this student only', async () => {
    const EXERCISE = id(405);
    const step = (over: Record<string, unknown>) => ({
      id: 'predict',
      title: 'Predict',
      kind: 'single_choice',
      status: 'completed',
      help: 'independent',
      checks: [],
      hintsShown: 0,
      solutionShown: false,
      finalResponse: 'narrower',
      ...over,
    });
    const attempt = (n: number, student: { id: string; name: string }, over = {}) => ({
      id: id(7000 + n),
      student,
      removed: false,
      number: n,
      resourceRevisionId: REVISION,
      seed: 4242,
      startedAt: NOW,
      completion: null,
      completedAt: null,
      restarted: false,
      steps: [],
      ...over,
    });
    const priya = { id: PRIYA, name: 'Priya Nair' };
    const base = review();
    serve({
      reviewData: {
        ...base,
        exercises: [{ exerciseId: EXERCISE, title: 'Sampling drill', topicId: TOPIC }],
      },
      extra: (path) =>
        path === `/resources/${EXERCISE}/exercise-attempts`
          ? {
              status: 200,
              body: {
                attempts: [
                  attempt(1, priya, {
                    completion: 'with_hints',
                    completedAt: NOW,
                    restarted: true,
                    steps: [
                      step({
                        help: 'with_hints',
                        hintsShown: 2,
                        checks: [
                          { response: 'halves', correct: false, at: NOW },
                          { response: 'narrower', correct: true, at: NOW },
                        ],
                      }),
                      step({
                        id: 'peek',
                        title: 'Peek',
                        help: 'solution_shown',
                        solutionShown: true,
                        finalResponse: 'n = 100',
                      }),
                    ],
                  }),
                  attempt(2, priya),
                  attempt(3, { id: SAM, name: 'Sam Okafor' }, { seed: 999 }),
                ],
              },
            }
          : undefined,
    });
    renderApp(`/classes/${CLASS_A}/review?assignment=${QUIZ}&selected=${PRIYA}&tab=exercises`);
    const region = await screen.findByRole('region', { name: 'Exercise · Sampling drill' });
    expect(await within(region).findByText('Attempt 1')).toBeVisible();
    expect(region).toHaveTextContent('Completed with hints');
    expect(region).toHaveTextContent('started again afterwards');
    expect(region).toHaveTextContent(`seed 4242 · exercise version ${REVISION}`);
    const predict = within(region).getByRole('list', { name: 'Attempt 1 Predict evidence' });
    expect(predict).toHaveTextContent('Final answer: narrower');
    expect(predict).toHaveTextContent('Checks made: 2');
    expect(predict).toHaveTextContent('Hints shown: 2');
    expect(predict).toHaveTextContent('Solution shown: No');
    expect(predict).toHaveTextContent('halves (incorrect) → narrower (correct)');
    const peek = within(region).getByRole('list', { name: 'Attempt 1 Peek evidence' });
    expect(peek).toHaveTextContent('Hints shown: 0');
    expect(peek).toHaveTextContent('Solution shown: Yes');
    expect(region).toHaveTextContent('Completed with the solution shown');
    // The second attempt is listed on its own, and another student's attempt is not shown.
    expect(within(region).getByText('Attempt 2')).toBeVisible();
    expect(region).toHaveTextContent('Not completed');
    expect(within(region).queryByText('Attempt 3')).toBeNull();
    expect(region).not.toHaveTextContent('seed 999');
  });

  it('A25 Comments & questions lists what the student shared and links to the source passage', async () => {
    const user = userEvent.setup({ delay: null });
    serve({
      extra: (path) => {
        if (path === `/students/${SAM}/discussions`) {
          return {
            status: 200,
            body: {
              discussions: [
                {
                  thread: {
                    id: id(9001),
                    resourceId: READING,
                    resourceRevisionId: REVISION,
                    anchor: {
                      kind: 'text',
                      blockId: '0123456789ab',
                      start: 6,
                      end: 12,
                      quote: 'sample',
                      prefix: 'Every ',
                      suffix: ' tells a slightly',
                    },
                    audience: 'instructor',
                    status: 'open',
                    author: { id: SAM, name: 'Sam Okafor' },
                    placement: {
                      resourceRevisionId: NEWER_REVISION,
                      status: 'mapped',
                      anchor: {
                        kind: 'text',
                        blockId: 'abcdefabcdef',
                        start: 9,
                        end: 15,
                        quote: 'sample',
                        prefix: 'Every ',
                        suffix: ' tells a slightly',
                      },
                      confidence: 0.9,
                    },
                    createdAt: NOW,
                    posts: [
                      {
                        id: id(9002),
                        parentId: null,
                        author: { id: SAM, name: 'Sam Okafor' },
                        authorRole: 'student',
                        body: 'Why n − 1?',
                        edited: false,
                        deleted: false,
                        moderated: false,
                        can: { edit: false, delete: false, moderate: true },
                        createdAt: NOW,
                      },
                    ],
                    can: { reply: true, resolve: true, reopen: false },
                  },
                  resource: { title: 'Sampling and uncertainty', tab: 'reading', topicId: TOPIC },
                },
              ],
            },
          };
        }
        return undefined;
      },
    });
    renderApp(`/classes/${CLASS_A}/review?assignment=${QUIZ}&selected=${SAM}`);
    await user.click(await screen.findByRole('tab', { name: 'Comments & questions' }));
    expect(await screen.findByText('Why n − 1?')).toBeVisible();
    expect(screen.getByText(/Shared with instructors · Open/)).toBeVisible();
    const link = screen.getByRole('link', {
      name: /Open source passage · Sampling and uncertainty/,
    });
    // The address names the revision the class studies now and the place the mapping found.
    const href = new URL(link.getAttribute('href') ?? '', 'http://app.test');
    expect(href.pathname).toBe(`/classes/${CLASS_A}/topics/${TOPIC}/reading`);
    expect(href.searchParams.get('resource')).toBe(NEWER_REVISION);
    expect(href.searchParams.get('block')).toBe('b:abcdefabcdef');
    expect(href.searchParams.get('offset')).toBe('9');
    expect(screen.getByText('“sample”')).toBeVisible();
  });

  it('A17 a grade changed by someone else replaces the form, and the next Save cannot overwrite it', async () => {
    const user = userEvent.setup({ delay: null });
    const theirs = gradeRow(2, {
      feedback: [{ target: { kind: 'attempt' }, text: 'Their feedback' }],
    });
    const calls = serve({
      history: [gradeRow(1)],
      extra: (path, method) =>
        method === 'POST' && path.endsWith('/grade')
          ? {
              status: 409,
              body: { error: 'revision_conflict', current: attemptGrade([theirs, gradeRow(1)]) },
            }
          : undefined,
    });
    renderApp(`/classes/${CLASS_A}/review?assignment=${QUIZ}&selected=${PRIYA}&attempt=${A_PRIYA}`);
    await screen.findByRole('region', { name: 'Grading workspace' });
    await user.type(screen.getByLabelText('Feedback to Priya Nair'), 'my stale edit');
    await user.click(screen.getByRole('button', { name: 'Save draft grade' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('your edits were not saved');
    // The inputs show the other grade, and there is nothing unsaved to send over it.
    expect(screen.getByLabelText('Feedback to Priya Nair')).toHaveValue('Their feedback');
    expect(screen.getByRole('button', { name: 'Save draft grade' })).toBeDisabled();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('A17 a grade that changes under unsaved edits keeps the edits, says so, and loads only on request', async () => {
    const user = userEvent.setup({ delay: null });
    const first = gradeRow(1);
    const theirs = gradeRow(2, {
      source: 'override',
      points: 4,
      feedback: [{ target: { kind: 'attempt' }, text: 'Their feedback' }],
    });
    let history = [first];
    const calls = serve({
      history,
      extra: (path, method) => {
        if (method === 'GET' && path === `/test-attempts/${A_PRIYA}/grade`) {
          return { status: 200, body: attemptGrade(history) };
        }
        if (method === 'POST' && path.endsWith('/grade')) {
          return {
            status: 409,
            body: { error: 'revision_conflict', current: attemptGrade(history) },
          };
        }
        return undefined;
      },
    });
    const { queryClient } = renderApp(
      `/classes/${CLASS_A}/review?assignment=${QUIZ}&selected=${PRIYA}&attempt=${A_PRIYA}`,
    );
    await screen.findByRole('region', { name: 'Grading workspace' });
    await user.type(screen.getByLabelText('Feedback to Priya Nair'), 'my unsaved words');
    history = [theirs, first];
    // Another instructor's save, a bulk release or a focus refetch all end in this read.
    await act(() => queryClient.invalidateQueries({ queryKey: ['grading', 'grade'] }));
    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('The grade changed while you were editing');
    expect(notice).toHaveTextContent('grade 2 · Override, 4 / 5');
    expect(screen.getByLabelText('Feedback to Priya Nair')).toHaveValue('my unsaved words');
    // Saving still sends the grade the edits were made on, so the server refuses it.
    await user.click(screen.getByRole('button', { name: 'Save draft grade' }));
    expect(await screen.findByText(/your edits were not saved/)).toBeVisible();
    expect(calls.find((c) => c.method === 'POST' && c.path.endsWith('/grade'))?.body).toMatchObject(
      {
        expectedGradeId: first.id,
      },
    );
    expect(screen.getByLabelText('Feedback to Priya Nair')).toHaveValue('Their feedback');
  });

  it('A17 Load latest grade replaces unsaved edits with the grade that changed under them', async () => {
    const user = userEvent.setup({ delay: null });
    const first = gradeRow(1);
    const theirs = gradeRow(2, {
      feedback: [{ target: { kind: 'attempt' }, text: 'Their feedback' }],
    });
    let history = [first];
    serve({
      history,
      extra: (path, method) =>
        method === 'GET' && path === `/test-attempts/${A_PRIYA}/grade`
          ? { status: 200, body: attemptGrade(history) }
          : undefined,
    });
    const { queryClient } = renderApp(
      `/classes/${CLASS_A}/review?assignment=${QUIZ}&selected=${PRIYA}&attempt=${A_PRIYA}`,
    );
    await screen.findByRole('region', { name: 'Grading workspace' });
    await user.type(screen.getByLabelText('Feedback to Priya Nair'), 'my unsaved words');
    history = [theirs, first];
    // Another instructor's save, a bulk release or a focus refetch all end in this read.
    await act(() => queryClient.invalidateQueries({ queryKey: ['grading', 'grade'] }));
    await user.click(await screen.findByRole('button', { name: 'Load latest grade' }));
    expect(screen.getByLabelText('Feedback to Priya Nair')).toHaveValue('Their feedback');
    expect(screen.queryByText(/The grade changed while you were editing/)).toBeNull();
  });

  it('A17 an override or regrade waits for unsaved edits to be saved, and cannot be sent twice', async () => {
    const user = userEvent.setup({ delay: null });
    const calls = serve({ history: [gradeRow(1)] });
    renderApp(`/classes/${CLASS_A}/review?assignment=${QUIZ}&selected=${PRIYA}&attempt=${A_PRIYA}`);
    await screen.findByRole('region', { name: 'Grading workspace' });
    await user.type(screen.getByLabelText('Feedback to Priya Nair'), 'unsent words');
    // Unsaved edits would be replaced by the new grade: save them first.
    expect(screen.getByRole('button', { name: 'Override grade' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Regrade from latest results' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save draft grade' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Override grade' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Override grade' }));
    const form = screen.getByRole('form', { name: 'Override grade' });
    await user.type(within(form).getByLabelText(/Points of 5/), '4');
    await user.type(within(form).getByLabelText('Reason'), 'Because');
    const submit = within(form).getByRole('button', { name: 'Save override as draft' });
    await user.dblClick(submit);
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Override grade' })).toBeNull());
    expect(calls.filter((c) => c.path.endsWith('/grade/override'))).toHaveLength(1);
  });

  it('A17 changing marks after opening the release preview stops Confirm from releasing the older draft', async () => {
    const user = userEvent.setup({ delay: null });
    const draft = gradeRow(1);
    const calls = serve({
      history: [draft],
      extra: (path) =>
        path === '/grade-releases/preview'
          ? {
              status: 200,
              body: {
                recipients: [
                  {
                    student: { id: PRIYA, name: 'Priya Nair' },
                    attemptId: A_PRIYA,
                    attemptNumber: 1,
                    resourceId: QUIZ,
                    gradeId: draft.id,
                    gradeNumber: 1,
                    points: 5,
                    possible: 5,
                  },
                ],
                skipped: [],
              },
            }
          : undefined,
    });
    renderApp(`/classes/${CLASS_A}/review?assignment=${QUIZ}&selected=${PRIYA}&attempt=${A_PRIYA}`);
    await screen.findByRole('region', { name: 'Grading workspace' });
    await user.click(await screen.findByRole('button', { name: 'Release feedback' }));
    const panel = await screen.findByRole('region', { name: 'Release preview' });
    await user.type(screen.getByLabelText('Feedback to Priya Nair'), 'late edit');
    const confirm = within(panel).getByRole('button', { name: 'Confirm release to 1 student' });
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(calls.some((c) => c.method === 'POST' && c.path === '/grade-releases')).toBe(false);
  });

  it('A17 a line comment must name a line of the file, and an empty comment is flagged, not dropped', async () => {
    const user = userEvent.setup({ delay: null });
    const calls = serve({
      history: [gradeRow(1)],
      extra: (path) =>
        path === `/test-attempts/${A_PRIYA}/review`
          ? {
              status: 200,
              body: {
                ...reviewedAttempt(A_PRIYA, { id: PRIYA, name: 'Priya Nair' }),
                test: {
                  schema: 'test.v1',
                  questions: [
                    {
                      id: 'mean',
                      kind: 'code',
                      prompt: 'Write mean(xs).',
                      points: 5,
                      rubric: [],
                    },
                  ],
                },
                answers: [
                  {
                    questionId: 'mean',
                    seq: 1,
                    savedAt: NOW,
                    flagged: false,
                    value: { files: [{ path: 'solution.py', content: 'a\nb\nc' }] },
                  },
                ],
              },
            }
          : undefined,
    });
    renderApp(`/classes/${CLASS_A}/review?assignment=${QUIZ}&selected=${PRIYA}&attempt=${A_PRIYA}`);
    await screen.findByRole('region', { name: 'Grading workspace' });
    await user.type(screen.getByLabelText('Line to comment on'), '99');
    await user.click(screen.getByRole('button', { name: 'Add line comment' }));
    expect(await screen.findByText('solution.py has lines 1 to 3.')).toBeVisible();
    await user.clear(screen.getByLabelText('Line to comment on'));
    await user.type(screen.getByLabelText('Line to comment on'), '2');
    await user.click(screen.getByRole('button', { name: 'Add line comment' }));
    await user.click(screen.getByRole('button', { name: 'Save draft grade' }));
    expect(await screen.findByText(/The comment on solution\.py line 2 has no text/)).toBeVisible();
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/grade'))).toBe(false);
  });

  it('A25 a removed student’s open attempt in the address shows their workspace without any other request', async () => {
    const data = review();
    serve({
      reviewData: {
        ...data,
        selected: {
          studentId: OLD,
          studentName: 'Olga Vance',
          attemptId: A_OLD,
          number: 1,
          assignmentId: QUIZ,
        },
      },
    });
    renderApp(`/classes/${CLASS_A}/review?selected=${OLD}&attempt=${A_OLD}`);
    const selection = await screen.findByRole('region', { name: 'Selected student' });
    expect(selection).toHaveTextContent('Olga Vance');
    expect(selection).toHaveTextContent('Attempt 1');
    expect(await screen.findByRole('region', { name: 'Grading workspace' })).toBeVisible();
  });

  it('A25 a tick on a student is dropped when the grade under it changes, and when the page changes', async () => {
    const user = userEvent.setup({ delay: null });
    let released = false;
    serve({
      extra: (path) => {
        if (path !== '/review') return undefined;
        const rows = [
          row(PRIYA, 'Priya Nair', A_PRIYA, {
            score: { points: released ? 4 : 5, possible: 5, state: 'draft' as const },
          }),
        ];
        return { status: 200, body: review(rows) };
      },
    });
    renderApp(`/classes/${CLASS_A}/review?assignment=${QUIZ}`);
    await screen.findByRole('table');
    await user.click(screen.getByRole('checkbox', { name: 'Select Priya Nair for release' }));
    expect(screen.getByRole('button', { name: 'Preview release (1)' })).toBeVisible();
    released = true;
    await user.selectOptions(screen.getByLabelText('Status'), 'needs');
    await user.selectOptions(screen.getByLabelText('Status'), 'all');
    expect(await screen.findByRole('button', { name: 'Preview release (0)' })).toBeVisible();
  });

  it('A25 a tick is dropped when a second unreleased change is saved over the same released grade', async () => {
    const user = userEvent.setup({ delay: null });
    let newest = id(1002);
    serve({
      extra: (path) => {
        if (path !== '/review') return undefined;
        const rows = [
          row(PRIYA, 'Priya Nair', A_PRIYA, {
            state: 'released',
            score: { points: 5, possible: 5, state: 'released' as const },
            unreleasedChange: true,
            gradeId: newest,
          }),
        ];
        return { status: 200, body: review(rows) };
      },
    });
    renderApp(`/classes/${CLASS_A}/review?assignment=${QUIZ}`);
    await screen.findByRole('table');
    await user.click(screen.getByRole('checkbox', { name: 'Select Priya Nair for release' }));
    expect(screen.getByRole('button', { name: 'Preview release (1)' })).toBeVisible();
    // A second override lands over the same released grade: score and flag are unchanged.
    newest = id(1003);
    await user.selectOptions(screen.getByLabelText('Status'), 'needs');
    await user.selectOptions(screen.getByLabelText('Status'), 'all');
    expect(await screen.findByRole('button', { name: 'Preview release (0)' })).toBeVisible();
  });

  it('A25 a bulk release that finds the grades changed refreshes the table as well as the preview', async () => {
    const user = userEvent.setup({ delay: null });
    const preview = {
      recipients: [
        {
          student: { id: PRIYA, name: 'Priya Nair' },
          attemptId: A_PRIYA,
          attemptNumber: 1,
          resourceId: QUIZ,
          gradeId: id(1001),
          gradeNumber: 1,
          points: 5,
          possible: 5,
        },
      ],
      skipped: [],
    };
    const calls = serve({
      extra: (path, method) => {
        if (path === '/grade-releases/preview') return { status: 200, body: preview };
        if (path === '/grade-releases' && method === 'POST') {
          return { status: 409, body: { error: 'release_changed', preview } };
        }
        return undefined;
      },
    });
    renderApp(`/classes/${CLASS_A}/review?assignment=${QUIZ}`);
    await screen.findByRole('table');
    await user.click(screen.getByRole('checkbox', { name: 'Select Priya Nair for release' }));
    await user.click(screen.getByRole('button', { name: 'Preview release (1)' }));
    const panel = await screen.findByRole('region', { name: 'Release preview' });
    const before = calls.filter((c) => c.path === '/review').length;
    await user.click(within(panel).getByRole('button', { name: 'Confirm release to 1 student' }));
    expect(await screen.findByText(/Grades changed while you were reviewing/)).toBeVisible();
    await waitFor(() =>
      expect(calls.filter((c) => c.path === '/review').length).toBeGreaterThan(before),
    );
  });

  it('A25 opening another attempt starts a new workspace, so a release preview never carries over', async () => {
    const user = userEvent.setup({ delay: null });
    const draft = gradeRow(1);
    serve({
      history: [draft],
      extra: (path) =>
        path === '/grade-releases/preview'
          ? {
              status: 200,
              body: {
                recipients: [
                  {
                    student: { id: PRIYA, name: 'Priya Nair' },
                    attemptId: A_PRIYA,
                    attemptNumber: 1,
                    resourceId: QUIZ,
                    gradeId: draft.id,
                    gradeNumber: 1,
                    points: 5,
                    possible: 5,
                  },
                ],
                skipped: [],
              },
            }
          : undefined,
    });
    renderApp(`/classes/${CLASS_A}/review?assignment=${QUIZ}&selected=${PRIYA}&attempt=${A_PRIYA}`);
    await screen.findByRole('region', { name: 'Grading workspace' });
    await user.click(await screen.findByRole('button', { name: 'Release feedback' }));
    expect(await screen.findByRole('region', { name: 'Release preview' })).toBeVisible();
    // Another attempt of the same student, then back: the preview is gone.
    await user.click(screen.getByRole('button', { name: 'Sam Okafor' }));
    expect(await screen.findByRole('heading', { name: 'Sam Okafor' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Priya Nair' }));
    await screen.findByRole('region', { name: 'Grading workspace' });
    expect(screen.queryByRole('region', { name: 'Release preview' })).toBeNull();
  });

  it('A25 a failed load of a notebook’s submissions says so and offers a retry', async () => {
    serve({
      extra: (path) =>
        path === `/resources/${NOTEBOOK}/notebook-submissions` ? { status: 500 } : undefined,
    });
    renderApp(`/classes/${CLASS_A}/review?assignment=${QUIZ}&selected=${PRIYA}&tab=submissions`);
    const notebook = await screen.findByRole('region', { name: 'Notebook · Sampling lab' });
    expect(await within(notebook).findByText('The submissions could not be loaded.')).toBeVisible();
    expect(within(notebook).getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('A25 the bulk release preview is dropped when the assignment changes', async () => {
    const user = userEvent.setup({ delay: null });
    serve({
      extra: (path, _method, _body, url) => {
        if (path === '/grade-releases/preview') {
          return { status: 200, body: { recipients: [], skipped: [] } };
        }
        // Without an assignment filter the server answers a table with no assignment chosen.
        if (path === '/review' && !url.searchParams.get('assignmentId')) {
          return { status: 200, body: { ...review(), assignment: null } };
        }
        return undefined;
      },
    });
    renderApp(`/classes/${CLASS_A}/review?assignment=${QUIZ}`);
    await screen.findByRole('table');
    await user.click(screen.getByRole('checkbox', { name: 'Select Priya Nair for release' }));
    await user.click(screen.getByRole('button', { name: 'Preview release (1)' }));
    expect(await screen.findByRole('region', { name: 'Release preview' })).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Assignment'), '');
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Release preview' })).toBeNull(),
    );
  });
});

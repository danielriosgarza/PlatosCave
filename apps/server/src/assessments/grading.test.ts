import { type TestQuestion, type TestV1, testV1 } from '@parallax/contracts';
import type { ManualMark } from '@parallax/contracts/routes/grades';
import { describe, expect, test } from 'vitest';
import {
  type CodeResult,
  feedbackProblem,
  manualFor,
  markOf,
  reportedOf,
  scoreAttempt,
  shares,
} from './grading';

const quiz: TestV1 = testV1.parse({
  questions: [
    {
      id: 'pick',
      kind: 'choice',
      prompt: 'Which varies least?',
      points: 2,
      options: [
        { id: 'a', label: 'n = 10' },
        { id: 'b', label: 'n = 100' },
      ],
      correct: ['b'],
    },
    { id: 'se', kind: 'numeric', prompt: 'SE?', points: 1, answer: 0.5, tolerance: 0.01 },
    {
      id: 'why',
      kind: 'explanation',
      prompt: 'Why?',
      points: 3,
      rubric: [
        { id: 'noise', label: 'Averaging out of noise', points: 2 },
        { id: 'root', label: 'Square root of n', points: 1 },
      ],
    },
    { id: 'free', kind: 'explanation', prompt: 'Anything else?', points: 2 },
    {
      id: 'mean',
      kind: 'code',
      prompt: 'Write mean(xs).',
      points: 6,
      rubric: [{ id: 'style', label: 'Readable', points: 2 }],
      runtime: 'python-3.12',
      files: [
        {
          path: 'solution.py',
          content: 'def mean(xs):\n    pass\n',
          editable: true,
          hidden: false,
        },
      ],
      checks: [
        {
          name: 'sample',
          kind: 'call',
          visibility: 'public',
          file: 'solution.py',
          function: 'mean',
          args: [[1, 2, 3]],
          expected: { value: 2 },
          compare: { mode: 'numeric' },
        },
        {
          name: 'hidden',
          kind: 'call',
          visibility: 'hidden',
          file: 'solution.py',
          function: 'mean',
          args: [[40, 44]],
          expected: { value: 42 },
          compare: { mode: 'numeric' },
          points: 3,
        },
      ],
    },
  ],
});

const answers = new Map<string, unknown>([
  ['pick', ['b']],
  ['se', 0.505],
  ['why', 'Noise averages out.'],
  [
    'mean',
    { files: [{ path: 'solution.py', content: 'def mean(xs):\n    return sum(xs) / len(xs)\n' }] },
  ],
]);
const sampleOnly: CodeResult = {
  status: 'scored',
  resultId: '00000000-0000-4000-8000-0000000000aa',
  outcomeStatus: 'failed',
  checks: [
    { name: 'sample', status: 'passed' },
    { name: 'hidden', status: 'failed' },
  ],
};
const marks = [
  { questionId: 'why', criteria: [{ id: 'noise', points: 2 }] },
  { questionId: 'free', points: 1.5 },
  { questionId: 'mean', criteria: [{ id: 'style', points: 2 }] },
];

describe('grade scoring', () => {
  test('a question splits into an automated share and its rubric', () => {
    expect(shares(quiz.questions[4] as TestV1['questions'][number])).toEqual({
      automated: 4,
      manual: 2,
    });
    expect(shares(quiz.questions[3] as TestV1['questions'][number])).toEqual({
      automated: 0,
      manual: 2,
    });
  });

  test('automated and manual components stay separate and add up', () => {
    const scored = scoreAttempt(quiz, answers, new Map([['mean', sampleOnly]]), marks, null);
    if (!scored.ok) throw new Error(scored.message);
    const byId = new Map(scored.value.questions.map((q) => [q.questionId, q]));
    expect(byId.get('pick')).toMatchObject({
      points: 2,
      automated: { points: 2, status: 'scored' },
    });
    expect(byId.get('se')?.points).toBe(1);
    expect(byId.get('why')).toMatchObject({
      automated: null,
      manual: { points: 2, possible: 3 },
      points: 2,
    });
    // One of four check points passed: a quarter of the automated share of 4.
    expect(byId.get('mean')).toMatchObject({
      automated: {
        points: 1,
        possible: 4,
        resultId: sampleOnly.status === 'scored' ? sampleOnly.resultId : null,
      },
      manual: { points: 2 },
      points: 3,
    });
    expect(scored.value).toMatchObject({
      automatedPoints: 4,
      manualPoints: 5.5,
      points: 9.5,
      possible: 14,
      complete: true,
    });
  });

  test('a pending or failed grading run and an unmarked question leave the grade incomplete', () => {
    for (const status of ['pending', 'unavailable'] as const) {
      const scored = scoreAttempt(quiz, answers, new Map([['mean', { status }]]), marks, null);
      if (!scored.ok) throw new Error(scored.message);
      const mean = scored.value.questions.find((q) => q.questionId === 'mean');
      expect(mean).toMatchObject({ automated: { status, points: null }, points: null });
      expect(scored.value.complete).toBe(false);
    }
    const unmarked = scoreAttempt(quiz, answers, new Map([['mean', sampleOnly]]), [], null);
    expect(unmarked.ok && unmarked.value.complete).toBe(false);
    // An override completes it and replaces the points; the components are unchanged.
    const overridden = scoreAttempt(quiz, answers, new Map(), [], { points: 12 });
    expect(overridden.ok && overridden.value).toMatchObject({
      points: 12,
      complete: true,
      manualPoints: 0,
    });
  });

  test('an unanswered question scores zero, never missing', () => {
    const scored = scoreAttempt(quiz, new Map(), new Map([['mean', sampleOnly]]), marks, null);
    if (!scored.ok) throw new Error(scored.message);
    expect(scored.value.questions.find((q) => q.questionId === 'pick')?.points).toBe(0);
  });

  test('manual marks are checked against the rubric', () => {
    const refused = [
      [{ questionId: 'why', criteria: [{ id: 'noise', points: 3 }] }],
      [{ questionId: 'why', criteria: [{ id: 'other', points: 1 }] }],
      [{ questionId: 'why', points: 2 }],
      [{ questionId: 'free', points: 3 }],
      [{ questionId: 'pick', points: 1 }],
      [{ questionId: 'nope', points: 1 }],
      [
        { questionId: 'free', points: 1 },
        { questionId: 'free', points: 1 },
      ],
    ];
    for (const m of refused) expect(scoreAttempt(quiz, answers, new Map(), m, null).ok).toBe(false);
  });

  test('a stored manual part round-trips through its mark, zero points included', () => {
    const q = (id: string) => quiz.questions.find((x) => x.id === id) as TestQuestion;
    const cases: [string, ManualMark][] = [
      ['why', { questionId: 'why', criteria: [{ id: 'noise', points: 2 }] }],
      ['why', { questionId: 'why', criteria: [] }],
      ['why', { questionId: 'why', criteria: [{ id: 'root', points: 0 }] }],
      ['mean', { questionId: 'mean', criteria: [] }],
      ['free', { questionId: 'free', points: 1.5 }],
      ['free', { questionId: 'free', points: 0 }],
    ];
    for (const [id, mark] of cases) {
      const first = manualFor(q(id), mark);
      if (!first.ok) throw new Error(first.message);
      const again = markOf(q(id), first.value);
      expect(again, `${id} ${JSON.stringify(mark)}`).toBeDefined();
      const second = manualFor(q(id), again);
      expect(second, `${id} ${JSON.stringify(mark)}`).toEqual(first);
    }
    expect(markOf(q('free'), { possible: 2, points: null, criteria: [] })).toBeUndefined();
  });

  test('feedback attaches to the attempt, a question or a line of submitted code', () => {
    const ok = [
      { target: { kind: 'attempt' as const }, text: 'Good.' },
      { target: { kind: 'question' as const, questionId: 'why' }, text: 'Name the root.' },
      {
        target: { kind: 'line' as const, questionId: 'mean', path: 'solution.py', line: 2 },
        text: 'Empty list?',
      },
    ];
    expect(feedbackProblem(quiz, answers, ok)).toBeNull();
    for (const target of [
      { kind: 'question' as const, questionId: 'nope' },
      { kind: 'line' as const, questionId: 'why', path: 'solution.py', line: 1 },
      { kind: 'line' as const, questionId: 'mean', path: 'other.py', line: 1 },
      { kind: 'line' as const, questionId: 'mean', path: 'solution.py', line: 4 },
    ]) {
      expect(feedbackProblem(quiz, answers, [{ target, text: 'x' }])).not.toBeNull();
    }
  });
});

describe('reported grade', () => {
  const graded = (n: number, points: number | null, selected = false) => ({
    attemptId: `a${n}`,
    number: n,
    selected,
    grade: points === null ? null : { id: `g${n}`, points, possible: 10 },
  });

  test('latest reports the latest attempt, and nothing while it has no grade', () => {
    expect(reportedOf('latest', [graded(1, 8), graded(2, 5)])?.attemptId).toBe('a2');
    expect(reportedOf('latest', [graded(1, 8), graded(2, null)])).toBeNull();
  });

  test('highest reports the best graded attempt', () => {
    expect(reportedOf('highest', [graded(1, 8), graded(2, 5), graded(3, null)])).toEqual({
      attemptId: 'a1',
      gradeId: 'g1',
      points: 8,
      possible: 10,
    });
  });

  test('instructor_selected reports the chosen attempt only', () => {
    expect(reportedOf('instructor_selected', [graded(1, 8), graded(2, 5, true)])?.attemptId).toBe(
      'a2',
    );
    expect(reportedOf('instructor_selected', [graded(1, 8)])).toBeNull();
  });
});

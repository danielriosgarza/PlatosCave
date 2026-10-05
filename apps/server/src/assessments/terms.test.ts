import {
  defaultAssignmentSettings,
  mergeSettings,
  settingsProblems,
  type TestV1,
  testAttemptMoves,
  testV1,
} from '@parallax/contracts';
import { describe, expect, test } from 'vitest';
import {
  acceptsUntil,
  deadlineFor,
  graderVersionOf,
  ineligibility,
  isLate,
  parseAnswer,
  questionView,
  termsFor,
} from './terms';

const quiz: TestV1 = testV1.parse({
  settings: { attempts: 2, durationMinutes: 30 },
  questions: [
    {
      id: 'spread',
      kind: 'choice',
      prompt: 'Which sample mean varies least?',
      points: 2,
      options: [
        { id: 'n10', label: 'n = 10' },
        { id: 'n100', label: 'n = 100' },
      ],
      correct: ['n100'],
      rubric: [{ id: 'right', label: 'Picks the larger sample', points: 2 }],
    },
    {
      id: 'se',
      kind: 'numeric',
      prompt: 'Standard error?',
      points: 1,
      answer: 0.5,
      tolerance: 0.01,
    },
    { id: 'why', kind: 'explanation', prompt: 'Why?', points: 3, maxLength: 20 },
    {
      id: 'mean',
      kind: 'code',
      prompt: 'Write mean(xs).',
      points: 4,
      runtime: 'python-3.12',
      files: [
        {
          path: 'solution.py',
          content: 'def mean(xs):\n    pass\n',
          editable: true,
          hidden: false,
        },
        { path: 'secret.txt', content: '42', editable: false, hidden: true },
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
          points: 1,
        },
        {
          name: 'hidden-large',
          kind: 'call',
          visibility: 'hidden',
          file: 'solution.py',
          files: ['secret.txt'],
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

const at = (iso: string) => new Date(iso);
const settings = mergeSettings(quiz.settings, {
  opensAt: '2026-10-01T08:00:00Z',
  closesAt: '2026-10-01T12:00:00Z',
});

describe('assignment terms', () => {
  test('defaults are one attempt, untimed, no late submission, manual release', () => {
    expect(defaultAssignmentSettings).toMatchObject({
      attempts: 1,
      durationMinutes: null,
      late: { policy: 'none' },
      release: { results: 'manual' },
    });
    expect(settingsProblems(defaultAssignmentSettings)).toEqual([]);
  });

  test('the class overrides the revision, which overrides the defaults', () => {
    expect(settings.attempts).toBe(2);
    expect(settings.durationMinutes).toBe(30);
    expect(mergeSettings(quiz.settings, { attempts: 3 }).attempts).toBe(3);
  });

  test('inconsistent terms are named', () => {
    const late = { policy: 'accept' as const, until: '2026-10-01T11:00:00Z' };
    expect(settingsProblems({ ...settings, late })).toEqual([
      'late submission must end after the closing time',
    ]);
    expect(settingsProblems({ ...settings, opensAt: settings.closesAt })).toHaveLength(1);
  });

  test('a timed deadline is the earlier of the close and the start plus duration', () => {
    const terms = termsFor(settings, null, 10);
    expect(deadlineFor(terms, at('2026-10-01T09:00:00Z'))).toEqual(at('2026-10-01T09:30:00Z'));
    expect(deadlineFor(terms, at('2026-10-01T11:50:00Z'))).toEqual(at('2026-10-01T12:00:00Z'));
  });

  test('an extension adds minutes, attempts and a personal closing time', () => {
    const override = { extraAttempts: 1, extraMinutes: 15, closesAt: '2026-10-02T12:00:00Z' };
    const terms = termsFor(settings, override, 10);
    expect(terms).toMatchObject({ attempts: 3, durationMinutes: 45, override });
    expect(deadlineFor(terms, at('2026-10-01T11:50:00Z'))).toEqual(at('2026-10-01T12:35:00Z'));
    expect(isLate(terms, at('2026-10-01T13:00:00Z'))).toBe(false);
  });

  test('late submission keeps work open until its end and marks it late', () => {
    const terms = termsFor(
      {
        ...settings,
        durationMinutes: null,
        late: { policy: 'accept', until: '2026-10-01T14:00:00Z' },
      },
      null,
      10,
    );
    expect(acceptsUntil(terms)).toEqual(at('2026-10-01T14:00:00Z'));
    expect(deadlineFor(terms, at('2026-10-01T09:00:00Z'))).toEqual(at('2026-10-01T14:00:00Z'));
    expect(isLate(terms, at('2026-10-01T12:00:01Z'))).toBe(true);
    expect(isLate(terms, at('2026-10-01T12:00:00Z'))).toBe(false);
  });

  test('untimed without a close has no deadline', () => {
    expect(deadlineFor(termsFor(defaultAssignmentSettings, null, 1), new Date())).toBeNull();
  });

  test('eligibility is decided from the server time and the attempts made', () => {
    const terms = termsFor(settings, null, 10);
    expect(ineligibility(terms, [], at('2026-10-01T07:59:59Z'))).toBe('not_open');
    expect(ineligibility(terms, [], at('2026-10-01T12:00:00Z'))).toBe('closed');
    expect(ineligibility(terms, [{ state: 'in_progress' }], at('2026-10-01T09:00:00Z'))).toBe(
      'in_progress',
    );
    const two = [{ state: 'submitted' }, { state: 'graded' }];
    expect(ineligibility(terms, two, at('2026-10-01T09:00:00Z'))).toBe('no_attempts_left');
    expect(ineligibility(terms, two.slice(1), at('2026-10-01T09:00:00Z'))).toBeNull();
  });

  test('attempt states follow the §11 diagram only', () => {
    expect(testAttemptMoves.in_progress).toEqual(['submitted']);
    expect(testAttemptMoves.needs_review).toEqual(['grading']);
    expect(testAttemptMoves.released).toEqual([]);
  });
});

describe('what a student receives', () => {
  test('questions carry no answer key, rubric, hidden check, hidden file or points of checks', () => {
    const views = quiz.questions.map(questionView);
    const text = JSON.stringify(views);
    for (const secret of [
      'correct',
      'answer',
      'tolerance',
      'rubric',
      'hidden',
      'secret.txt',
      '42',
    ]) {
      expect(text).not.toContain(secret);
    }
    const code = views.find((v) => v.kind === 'code');
    expect(code).toMatchObject({
      files: [{ path: 'solution.py', editable: true }],
      sampleChecks: [{ name: 'sample', expected: { value: 2 } }],
    });
    expect(JSON.stringify(code)).not.toMatch(/visibility|points"\s*:\s*1/);
  });

  test('the grader version names the grading material, not the wording', () => {
    const reworded = testV1.parse({
      ...quiz,
      questions: quiz.questions.map((q) => ({ ...q, prompt: `${q.prompt} (reworded)` })),
    });
    expect(graderVersionOf(reworded)).toBe(graderVersionOf(quiz));
    const rekeyed = testV1.parse({
      ...quiz,
      questions: quiz.questions.map((q) => (q.kind === 'numeric' ? { ...q, answer: 0.6 } : q)),
    });
    expect(graderVersionOf(rekeyed)).not.toBe(graderVersionOf(quiz));
  });
});

describe('answers are checked before they are acknowledged', () => {
  const [choice, numeric, explanation, code] = quiz.questions as [
    TestV1['questions'][number],
    TestV1['questions'][number],
    TestV1['questions'][number],
    TestV1['questions'][number],
  ];

  test.each([
    [choice, ['n100'], true],
    [choice, ['n10', 'n100'], false],
    [choice, ['other'], false],
    [numeric, 0.5, true],
    [numeric, '0.5', false],
    [explanation, 'Averaging.', true],
    [explanation, 'x'.repeat(21), false],
    [code, { files: [{ path: 'solution.py', content: 'def mean(xs): ...' }] }, true],
    [code, { files: [{ path: 'secret.txt', content: '0' }] }, false],
    [code, { files: [{ path: 'missing.py', content: '' }] }, false],
  ])('%#: %j', (question, value, ok) => {
    expect(parseAnswer(question, value).ok).toBe(ok);
  });

  test('null clears an answer', () => {
    expect(parseAnswer(choice, null)).toEqual({ ok: true, value: null });
  });
});

describe('test.v1', () => {
  test('rejects duplicate ids, keys outside the options, and code without an editable file', () => {
    const base = quiz.questions[0];
    expect(testV1.safeParse({ questions: [base, base] }).success).toBe(false);
    expect(testV1.safeParse({ questions: [{ ...base, correct: ['x'] }] }).success).toBe(false);
    const code = quiz.questions[3];
    if (code?.kind !== 'code') throw new Error('fixture');
    const locked = { ...code, files: code.files.map((f) => ({ ...f, editable: false })) };
    expect(testV1.safeParse({ questions: [locked] }).success).toBe(false);
  });

  test('a check that is not a runner check is rejected', () => {
    const code = quiz.questions[3];
    if (code?.kind !== 'code') throw new Error('fixture');
    const broken = { ...code, checks: [{ name: 'x', kind: 'call', points: 1 }] };
    expect(testV1.safeParse({ questions: [broken] }).success).toBe(false);
  });
});

import type { TestQuestion, TestV1 } from '@parallax/contracts';
import type {
  AutomatedScore,
  FeedbackItem,
  ManualMark,
  ManualScore,
  QuestionScore,
} from '@parallax/contracts/routes/grades';

/**
 * Scoring rules of a grade (§11), pure so they are tested without a database. A question's
 * points split into an automated share (answer key or code checks) and a manual share (its
 * rubric's criteria; the whole question for an explanation without criteria). A code question's
 * automated points are the points of its passed checks over the points of all its checks
 * (docs/design/runner.md §8.7). A missing part leaves the question without points, and a grade
 * with such a question is incomplete until an override replaces it.
 */

/** A code question's grading run as the grade reads it. */
export type CodeResult =
  | {
      status: 'scored';
      resultId: string;
      outcomeStatus: string;
      checks: { name: string; status: string }[];
    }
  | { status: 'pending' | 'unavailable' };

const round = (n: number) => Math.round(n * 100) / 100;
const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

export function shares(q: TestQuestion): { automated: number; manual: number } {
  const rubric = sum(q.rubric.map((c) => c.points));
  if (q.kind === 'explanation') {
    return { automated: 0, manual: q.rubric.length > 0 ? Math.min(rubric, q.points) : q.points };
  }
  const manual = Math.min(rubric, q.points);
  return { automated: q.points - manual, manual };
}

function sameSet(a: unknown, b: string[]) {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  const want = new Set(b);
  return a.every((v) => typeof v === 'string' && want.has(v)) && new Set(a).size === b.length;
}

/** The automated part of a question; null for an explanation, which has none. */
export function automatedFor(
  q: TestQuestion,
  answer: unknown,
  code: CodeResult | undefined,
): AutomatedScore | null {
  const possible = shares(q).automated;
  const scored = (fraction: number, resultId: string | null = null): AutomatedScore => ({
    possible,
    points: round(possible * fraction),
    status: 'scored',
    resultId,
  });
  switch (q.kind) {
    case 'explanation':
      return null;
    case 'choice':
      return scored(sameSet(answer, q.correct) ? 1 : 0);
    case 'numeric':
      return scored(
        typeof answer === 'number' && Math.abs(answer - q.answer) <= q.tolerance ? 1 : 0,
      );
    case 'code': {
      if (code?.status !== 'scored') {
        return { possible, points: null, status: code?.status ?? 'pending', resultId: null };
      }
      const passed = new Set(code.checks.filter((c) => c.status === 'passed').map((c) => c.name));
      const total = sum(q.checks.map((c) => c.points));
      const earned = sum(q.checks.filter((c) => passed.has(c.name)).map((c) => c.points));
      const fraction = total > 0 ? earned / total : code.outcomeStatus === 'passed' ? 1 : 0;
      return scored(fraction, code.resultId);
    }
  }
}

type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

/** The manual part of a question from the instructor's mark; null when it has no manual share. */
export function manualFor(
  q: TestQuestion,
  mark: ManualMark | undefined,
): Checked<ManualScore | null> {
  const possible = shares(q).manual;
  const refuse = (message: string) => ({ ok: false as const, message });
  if (possible === 0 && q.rubric.length === 0) {
    return mark ? refuse(`Question ${q.id} takes no manual points`) : { ok: true, value: null };
  }
  if (!mark) return { ok: true, value: { possible, points: null, criteria: [] } };
  if (q.rubric.length === 0) {
    if (mark.criteria?.length) return refuse(`Question ${q.id} has no rubric criteria`);
    if (mark.points === undefined) return refuse(`Give question ${q.id} its points`);
    if (mark.points > possible) return refuse(`Question ${q.id} is worth at most ${possible}`);
    return { ok: true, value: { possible, points: round(mark.points), criteria: [] } };
  }
  if (mark.points !== undefined) return refuse(`Mark question ${q.id} by its rubric criteria`);
  const rubric = new Map(q.rubric.map((c) => [c.id, c.points]));
  const criteria = mark.criteria ?? [];
  const seen = new Set<string>();
  for (const c of criteria) {
    const most = rubric.get(c.id);
    if (most === undefined || seen.has(c.id)) {
      return refuse(`Question ${q.id} has no criterion ${c.id}, or it is marked twice`);
    }
    if (c.points > most) return refuse(`Criterion ${c.id} is worth at most ${most}`);
    seen.add(c.id);
  }
  const marked = criteria.map((c) => ({ id: c.id, points: round(c.points) }));
  return {
    ok: true,
    value: {
      possible,
      points: round(Math.min(sum(marked.map((c) => c.points)), possible)),
      criteria: marked,
    },
  };
}

/**
 * The mark that reproduces a stored manual part (a regrade or override carries it over). A
 * question with rubric criteria is always marked by its criteria, even when none was awarded.
 */
export function markOf(q: TestQuestion, manual: ManualScore | null): ManualMark | undefined {
  if (!manual || manual.points === null) return undefined;
  return q.rubric.length > 0
    ? { questionId: q.id, criteria: manual.criteria }
    : { questionId: q.id, points: manual.points };
}

export interface Scored {
  questions: QuestionScore[];
  automatedPoints: number;
  manualPoints: number;
  points: number;
  possible: number;
  complete: boolean;
}

/** Scores an attempt: every question of its pinned test, then the totals. */
export function scoreAttempt(
  test: TestV1,
  answers: Map<string, unknown>,
  code: Map<string, CodeResult>,
  marks: ManualMark[],
  override: { points: number } | null,
): Checked<Scored> {
  const byQuestion = new Map<string, ManualMark>();
  for (const mark of marks) {
    if (!test.questions.some((q) => q.id === mark.questionId) || byQuestion.has(mark.questionId)) {
      return {
        ok: false,
        message: `Question ${mark.questionId} is not in this test, or is marked twice`,
      };
    }
    byQuestion.set(mark.questionId, mark);
  }
  const questions: QuestionScore[] = [];
  for (const q of test.questions) {
    const manual = manualFor(q, byQuestion.get(q.id));
    if (!manual.ok) return manual;
    const automated = automatedFor(q, answers.get(q.id), code.get(q.id));
    const missing = automated?.points === null || manual.value?.points === null;
    questions.push({
      questionId: q.id,
      possible: q.points,
      automated,
      manual: manual.value,
      points: missing
        ? null
        : round(Math.min((automated?.points ?? 0) + (manual.value?.points ?? 0), q.points)),
    });
  }
  const automatedPoints = round(sum(questions.map((q) => q.automated?.points ?? 0)));
  const manualPoints = round(sum(questions.map((q) => q.manual?.points ?? 0)));
  return {
    ok: true,
    value: {
      questions,
      automatedPoints,
      manualPoints,
      points: override ? override.points : round(automatedPoints + manualPoints),
      possible: sum(test.questions.map((q) => q.points)),
      complete: override !== null || questions.every((q) => q.points !== null),
    },
  };
}

const lineCount = (text: string) => text.split('\n').length;

/** Why feedback cannot attach where it says; null when every item can. */
export function feedbackProblem(
  test: TestV1,
  answers: Map<string, unknown>,
  items: FeedbackItem[],
): string | null {
  for (const { target } of items) {
    if (target.kind === 'attempt') continue;
    const q = test.questions.find((x) => x.id === target.questionId);
    if (!q) return `Question ${target.questionId} is not in this test`;
    if (target.kind === 'question') continue;
    if (q.kind !== 'code') return `Question ${q.id} has no code lines`;
    const submitted = (answers.get(q.id) as { files?: { path: string; content: string }[] } | null)
      ?.files;
    const file =
      submitted?.find((f) => f.path === target.path) ??
      q.files.find((f) => f.path === target.path && !f.hidden);
    if (!file) return `Question ${q.id} has no file ${target.path}`;
    if (target.line > lineCount(file.content)) {
      return `${target.path} has ${lineCount(file.content)} lines`;
    }
  }
  return null;
}

export type ReportRule = 'latest' | 'highest' | 'instructor_selected';
export interface Reportable {
  attemptId: string;
  number: number;
  selected: boolean;
  grade: { id: string; points: number; possible: number } | null;
}

/**
 * The reported grade under the assignment's rule (§11), over submitted attempts: the latest
 * attempt's grade (none while it has none, never an older one), the highest grade, or the
 * instructor's chosen attempt.
 */
export function reportedOf(rule: ReportRule, attempts: Reportable[]) {
  const pick = (a: Reportable | undefined) =>
    a?.grade
      ? {
          attemptId: a.attemptId,
          gradeId: a.grade.id,
          points: a.grade.points,
          possible: a.grade.possible,
        }
      : null;
  if (rule === 'instructor_selected') return pick(attempts.find((a) => a.selected));
  if (rule === 'latest') return pick([...attempts].sort((a, b) => b.number - a.number)[0]);
  const graded = attempts.filter((a) => a.grade !== null);
  graded.sort((a, b) => (b.grade?.points ?? 0) - (a.grade?.points ?? 0) || b.number - a.number);
  return pick(graded[0]);
}

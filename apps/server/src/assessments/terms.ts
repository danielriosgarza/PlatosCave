import { createHash } from 'node:crypto';
import {
  type AssignmentSettings,
  clampLimits,
  type TestQuestion,
  type TestQuestionView,
  type TestV1,
} from '@parallax/contracts';
import { canonical } from '../db/content/drafts';

/**
 * The rules of an assigned test (§11), pure so they are tested without a database: effective
 * terms, the deadline, eligibility, lateness, the student's view of a question and the checks
 * an answer must pass before it is acknowledged. The server alone applies them; the browser's
 * clock decides nothing.
 */

export interface Override {
  extraAttempts: number;
  extraMinutes: number;
  closesAt: string | null;
}

export type Terms = AssignmentSettings & { override: Override | null; totalPoints: number };

export const totalPoints = (test: TestV1) => test.questions.reduce((sum, q) => sum + q.points, 0);

/** The class's settings with the student's override in force applied. */
export function termsFor(
  settings: AssignmentSettings,
  override: Override | null,
  points: number,
): Terms {
  return {
    ...settings,
    attempts: settings.attempts + (override?.extraAttempts ?? 0),
    durationMinutes:
      settings.durationMinutes === null
        ? null
        : settings.durationMinutes + (override?.extraMinutes ?? 0),
    // An explicit extension replaces the class's closing time (§11).
    closesAt: override?.closesAt ?? settings.closesAt,
    override,
    totalPoints: points,
  };
}

const time = (iso: string | null) => (iso === null ? null : new Date(iso));

/** The last moment work is accepted: the closing time, or the end of late submission. */
export function acceptsUntil(terms: Terms): Date | null {
  const closes = time(terms.closesAt);
  if (!closes || terms.late.policy === 'none') return closes;
  const until = new Date(terms.late.until);
  return until > closes ? until : closes;
}

/**
 * When the server submits an attempt started at `startedAt`: the earlier of the start plus the
 * adjusted duration and the last moment work is accepted; null when neither applies.
 */
export function deadlineFor(terms: Terms, startedAt: Date): Date | null {
  const candidates = [acceptsUntil(terms)];
  if (terms.durationMinutes !== null) {
    candidates.push(new Date(startedAt.getTime() + terms.durationMinutes * 60_000));
  }
  const set = candidates.filter((d): d is Date => d !== null);
  return set.length === 0 ? null : new Date(Math.min(...set.map((d) => d.getTime())));
}

/** Received after the (possibly extended) closing time. */
export const isLate = (terms: Terms, at: Date) => {
  const closes = time(terms.closesAt);
  return closes !== null && at > closes;
};

export type Ineligibility = 'not_open' | 'closed' | 'no_attempts_left' | 'in_progress';

/** Why a new attempt cannot start now, or null when it can. */
export function ineligibility(
  terms: Terms,
  attempts: { state: string }[],
  now: Date,
): Ineligibility | null {
  if (attempts.some((a) => a.state === 'in_progress')) return 'in_progress';
  const opens = time(terms.opensAt);
  if (opens && now < opens) return 'not_open';
  const until = acceptsUntil(terms);
  if (until && now >= until) return 'closed';
  if (attempts.length >= terms.attempts) return 'no_attempts_left';
  return null;
}

/**
 * Identifies everything that grades the test: every question field except its prompt and the
 * labels a student reads, so a started attempt names the grader it will be graded by (A16).
 */
export function graderVersionOf(test: TestV1): string {
  const grading = test.questions.map(({ prompt: _prompt, ...rest }) => rest);
  return createHash('sha256')
    .update(canonical({ format: 'test.v1', questions: grading }))
    .digest('hex')
    .slice(0, 16);
}

/** A question as a student sees it: no answer key, rubric, hidden check or hidden file. */
export function questionView(q: TestQuestion): TestQuestionView {
  const base = { id: q.id, prompt: q.prompt, points: q.points };
  switch (q.kind) {
    case 'choice':
      return { ...base, kind: q.kind, options: q.options, multiple: q.multiple };
    case 'numeric':
      return { ...base, kind: q.kind, ...(q.unit !== undefined && { unit: q.unit }) };
    case 'explanation':
      return { ...base, kind: q.kind, maxLength: q.maxLength };
    case 'code':
      return {
        ...base,
        kind: q.kind,
        runtime: q.runtime,
        allowedPackages: q.allowedPackages,
        files: q.files
          .filter((f) => !f.hidden)
          .map((f) => ({
            path: f.path,
            content: f.content,
            ...(f.encoding && { encoding: f.encoding }),
            editable: f.editable,
          })),
        limits: clampLimits(q.limits),
        sampleChecks: q.checks
          .filter((c) => c.visibility === 'public')
          .map(({ points: _points, visibility: _visibility, ...check }) => check),
      };
  }
}

/** The editable files of a code answer may hold at most this much text in total. */
export const MAX_CODE_ANSWER_BYTES = 2 * 1024 * 1024;

type Parsed = { ok: true; value: unknown } | { ok: false; message: string };
const refuse = (message: string): Parsed => ({ ok: false, message });

/** Checks a saved answer against its question; `null` clears it. */
export function parseAnswer(q: TestQuestion, value: unknown): Parsed {
  if (value === null || value === undefined) return { ok: true, value: null };
  switch (q.kind) {
    case 'choice': {
      const ids = new Set(q.options.map((o) => o.id));
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && ids.has(v))) {
        return refuse('Choose from this question’s options');
      }
      if (new Set(value).size !== value.length) return refuse('Each option can be chosen once');
      if (!q.multiple && value.length > 1) return refuse('This question takes one option');
      return { ok: true, value };
    }
    case 'numeric':
      return typeof value === 'number' && Number.isFinite(value)
        ? { ok: true, value }
        : refuse('Enter a number');
    case 'explanation':
      if (typeof value !== 'string') return refuse('Enter text');
      return value.length <= q.maxLength
        ? { ok: true, value }
        : refuse(`Keep the answer within ${q.maxLength} characters`);
    case 'code': {
      const editable = new Set(q.files.filter((f) => f.editable && !f.hidden).map((f) => f.path));
      const files = (value as { files?: unknown }).files;
      if (typeof value !== 'object' || !Array.isArray(files)) return refuse('Send the code files');
      let bytes = 0;
      const seen = new Set<string>();
      for (const file of files as { path?: unknown; content?: unknown }[]) {
        if (typeof file?.path !== 'string' || !editable.has(file.path) || seen.has(file.path)) {
          return refuse('Only this question’s editable files can be saved');
        }
        if (typeof file.content !== 'string') return refuse('A file’s content must be text');
        seen.add(file.path);
        bytes += Buffer.byteLength(file.content, 'utf8');
      }
      if (bytes > MAX_CODE_ANSWER_BYTES) return refuse('The code is larger than 2 MiB');
      return {
        ok: true,
        value: {
          files: (files as { path: string; content: string }[]).map((f) => ({
            path: f.path,
            content: f.content,
          })),
        },
      };
    }
  }
}

/** Whether a saved value answers its question (a cleared or empty answer does not). */
export const answers = (value: unknown) =>
  value !== null &&
  value !== undefined &&
  value !== '' &&
  !(Array.isArray(value) && value.length === 0);

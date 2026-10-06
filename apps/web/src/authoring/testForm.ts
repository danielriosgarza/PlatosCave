import {
  defaultAssignmentSettings,
  mergeSettings,
  RUNNER_BOUNDS,
  testV1,
} from '@parallax/contracts';

/**
 * The test editor's form model (§11, §12). Everything an author types is held as text, so a
 * half-typed number or JSON value stays on screen; `toContent` builds `test.v1` from it and
 * `problemsOf` says why it cannot be saved yet. Only valid content becomes a revision.
 */

export type QuestionKind = 'choice' | 'numeric' | 'explanation' | 'code';
export type CheckKind = 'stdio' | 'call' | 'script';

export interface DraftCriterion {
  id: string;
  label: string;
  points: string;
}
export interface DraftOption {
  /** Client-only identity; never saved, so editing `id` keeps the correct mark on its option. */
  uid: string;
  id: string;
  label: string;
}
export interface DraftFile {
  /** Client-only identity; never saved, so editing `path` keeps the checks set on the file. */
  uid: string;
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64';
  editable: boolean;
  hidden: boolean;
}
export interface DraftCheck {
  name: string;
  visibility: 'public' | 'hidden';
  kind: CheckKind;
  file: string;
  /** The `uid` of the file `file` names, so the check follows that file when its path is edited. */
  fileUid: string;
  /** One path per line. */
  files: string;
  points: string;
  timeoutSeconds: string;
  /** stdio and script: one argument per line. call: a JSON array. */
  args: string;
  /** call: the function to call, and a JSON object of keyword arguments. */
  fn: string;
  kwargs: string;
  stdin: string;
  expectedStdout: string;
  exitCode: string;
  /** call: the expected value as JSON, or an exception type. */
  expects: 'value' | 'raises';
  expectedValue: string;
  raisesType: string;
  raisesMessage: string;
  compareMode: string;
  abs: string;
  rel: string;
}
export interface DraftQuestion {
  /** Client-only identity for React keys; never saved, so editing `id` does not remount. */
  uid: string;
  kind: QuestionKind;
  id: string;
  prompt: string;
  points: string;
  rubric: DraftCriterion[];
  options: DraftOption[];
  /** The `uid`s of the correct options. */
  correct: string[];
  multiple: boolean;
  answer: string;
  tolerance: string;
  unit: string;
  maxLength: string;
  runtime: string;
  files: DraftFile[];
  allowedPackages: string[];
  limits: { wallSeconds: string; memoryMiB: string; outputBytes: string };
  checks: DraftCheck[];
}
export interface DraftSettings {
  attempts: string;
  durationMinutes: string;
  /** `datetime-local` values in the author's time zone. */
  opensAt: string;
  closesAt: string;
  timeZone: string;
  late: 'none' | 'accept';
  lateUntil: string;
  releaseResults: 'manual' | 'scheduled';
  releaseAt: string;
  solutions: 'never' | 'with_results';
  hiddenTestDetails: boolean;
  reportedGrade: 'latest' | 'highest' | 'instructor_selected';
  allowedMaterials: string;
}
export interface DraftTest {
  settings: DraftSettings;
  questions: DraftQuestion[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): string => (typeof v === 'number' ? String(v) : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** An ISO time as a `datetime-local` value in the browser's zone; empty when absent. */
export function toLocalInput(iso: unknown): string {
  if (typeof iso !== 'string') return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  // Seconds are kept when set, so an unrelated save does not move a stored 23:59:59 to 23:59.
  const s = d.getSeconds() ? `:${p(d.getSeconds())}` : '';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}${s}`;
}
const fromLocalInput = (value: string): string | null => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

let uids = 0;
export const newUid = (prefix: string): string => `${prefix}-${++uids}`;

export const blankFile = (path = ''): DraftFile => ({
  uid: newUid('file'),
  path,
  content: '',
  editable: false,
  hidden: false,
});

/** The uid of the first file with `path`, or '' when none has it. */
export const fileUidOf = (files: { uid: string; path: string }[], path: string): string =>
  files.find((f) => f.path === path)?.uid ?? '';

export const blankCheck = (file = '', fileUid = ''): DraftCheck => ({
  name: '',
  visibility: 'public',
  kind: 'call',
  file,
  fileUid,
  files: '',
  points: '1',
  timeoutSeconds: '',
  args: '[]',
  fn: '',
  kwargs: '',
  stdin: '',
  expectedStdout: '',
  exitCode: '',
  expects: 'value',
  expectedValue: '',
  raisesType: '',
  raisesMessage: '',
  compareMode: 'exact',
  abs: '',
  rel: '',
});

export const blankQuestion = (kind: QuestionKind, id: string): DraftQuestion => {
  const file = { ...blankFile('solution.py'), editable: true };
  return {
    uid: newUid('question'),
    kind,
    id,
    prompt: '',
    points: '1',
    rubric: [],
    options: [
      { uid: newUid('option'), id: 'a', label: '' },
      { uid: newUid('option'), id: 'b', label: '' },
    ],
    correct: [],
    multiple: false,
    answer: '',
    tolerance: '0',
    unit: '',
    maxLength: '5000',
    runtime: '',
    files: [file],
    allowedPackages: [],
    limits: { wallSeconds: '', memoryMiB: '', outputBytes: '' },
    checks: [{ ...blankCheck('solution.py', file.uid), name: 'sample' }],
  };
};

/** The first letter from `a` that no option uses yet (a question has at most 12 options). */
export function nextOptionId(options: { id: string }[]): string {
  const used = new Set(options.map((o) => o.id));
  for (let n = 0; n < 26; n++) {
    const id = String.fromCharCode(97 + n);
    if (!used.has(id)) return id;
  }
  return `o${options.length + 1}`;
}

/** The next free rubric criterion id: `c1`, `c2`, …. */
export function nextCriterionId(rubric: { id: string }[]): string {
  const used = new Set(rubric.map((r) => r.id));
  for (let n = rubric.length + 1; ; n++) if (!used.has(`c${n}`)) return `c${n}`;
}

/**
 * The checks of a question after `file` is renamed to `to`, or removed when `to` is undefined: a
 * check keeps naming the file it was set on, found by the file's uid, so a path that is empty or
 * equal to another file's while it is retyped does not move another file's checks. The extra
 * files a check lists are paths only, so they follow a rename only when no other file has the
 * old path.
 */
export function checksAfterFileChange(
  checks: DraftCheck[],
  file: { uid: string; path: string },
  to: string | undefined,
  files: { path: string }[],
): DraftCheck[] {
  const from = file.path;
  const unique = files.filter((f) => f.path === from).length === 1;
  return checks.map((c) => {
    const listed = c.files.split('\n');
    const others =
      unique && from !== '' && listed.includes(from)
        ? listed.flatMap((p) => (p === from ? (to === undefined ? [] : [to]) : [p])).join('\n')
        : c.files;
    const mine = c.fileUid === file.uid;
    const named = mine ? (to ?? '') : c.file;
    const fileUid = mine && to === undefined ? '' : c.fileUid;
    return named === c.file && others === c.files && fileUid === c.fileUid
      ? c
      : { ...c, file: named, files: others, fileUid };
  });
}

/** A check set to another kind: standard input belongs to `stdio` checks, so it is cleared. */
export const withKind = (c: DraftCheck, kind: CheckKind): DraftCheck => ({
  ...c,
  kind,
  compareMode: kind === 'call' ? 'exact' : 'trimmed',
  args: kind === 'call' ? '[]' : '',
  stdin: kind === 'stdio' ? c.stdin : '',
});

/** The next free question id: `q1`, `q2`, …. */
export function nextQuestionId(questions: { id: string }[]): string {
  const used = new Set(questions.map((q) => q.id));
  for (let n = questions.length + 1; ; n++) if (!used.has(`q${n}`)) return `q${n}`;
}

const json = (v: unknown): string => (v === undefined ? '' : JSON.stringify(v));

function toDraftCheck(raw: unknown): DraftCheck {
  const c = obj(raw);
  const expected = obj(c.expected);
  const raises = obj(expected.raises);
  const compare = obj(c.compare);
  const kind: CheckKind = c.kind === 'stdio' || c.kind === 'script' ? c.kind : 'call';
  return {
    ...blankCheck(str(c.file)),
    name: str(c.name),
    visibility: c.visibility === 'hidden' ? 'hidden' : 'public',
    kind,
    files: arr(c.files).map(str).join('\n'),
    points: num(c.points) || '1',
    timeoutSeconds: num(c.timeoutSeconds),
    args: kind === 'call' ? json(c.args ?? []) : arr(c.args).map(str).join('\n'),
    fn: str(c.function),
    kwargs: json(c.kwargs),
    stdin: str(c.stdin),
    expectedStdout: str(expected.stdout),
    exitCode: num(expected.exitCode),
    expects: 'raises' in expected ? 'raises' : 'value',
    expectedValue: 'value' in expected ? json(expected.value) : '',
    raisesType: str(raises.type),
    raisesMessage: str(raises.message),
    compareMode: str(compare.mode) || (kind === 'call' ? 'exact' : 'trimmed'),
    abs: num(compare.abs),
    rel: num(compare.rel),
  };
}

function toDraftQuestion(raw: unknown): DraftQuestion {
  const q = obj(raw);
  const kind: QuestionKind =
    q.kind === 'choice' || q.kind === 'numeric' || q.kind === 'code' ? q.kind : 'explanation';
  const limits = obj(q.limits);
  const options = arr(q.options).map((o) => ({
    uid: newUid('option'),
    id: str(obj(o).id),
    label: str(obj(o).label),
  }));
  const ids = arr(q.correct).map(str);
  const files = arr(q.files).map((f) => {
    const o = obj(f);
    return {
      uid: newUid('file'),
      path: str(o.path),
      content: str(o.content),
      ...(o.encoding === 'base64' && { encoding: 'base64' as const }),
      editable: o.editable === true,
      hidden: o.hidden === true,
    };
  });
  return {
    ...blankQuestion(kind, str(q.id)),
    prompt: str(q.prompt),
    points: num(q.points) || '1',
    rubric: arr(q.rubric).map((r) => ({
      id: str(obj(r).id),
      label: str(obj(r).label),
      points: num(obj(r).points),
    })),
    options,
    correct: options.filter((o) => ids.includes(o.id)).map((o) => o.uid),
    multiple: q.multiple === true,
    answer: num(q.answer),
    tolerance: num(q.tolerance) || '0',
    unit: str(q.unit),
    maxLength: num(q.maxLength) || '5000',
    runtime: str(q.runtime),
    files,
    allowedPackages: arr(q.allowedPackages).map(str),
    limits: {
      wallSeconds: num(limits.wallSeconds),
      memoryMiB: num(limits.memoryMiB),
      outputBytes: num(limits.outputBytes),
    },
    checks: arr(q.checks)
      .map(toDraftCheck)
      .map((c) => ({ ...c, fileUid: fileUidOf(files, c.file) })),
  };
}

/** The form of stored content; settings the author never set show the §11 defaults. */
export function toDraft(content: unknown): DraftTest {
  const c = obj(content);
  const s = mergeSettings(obj(c.settings) as Parameters<typeof mergeSettings>[0]);
  return {
    settings: {
      attempts: String(s.attempts),
      durationMinutes: s.durationMinutes === null ? '' : String(s.durationMinutes),
      opensAt: toLocalInput(s.opensAt),
      closesAt: toLocalInput(s.closesAt),
      timeZone: s.timeZone,
      late: s.late.policy,
      lateUntil: s.late.policy === 'accept' ? toLocalInput(s.late.until) : '',
      releaseResults: s.release.results,
      releaseAt: toLocalInput(s.release.at),
      solutions: s.release.solutions,
      hiddenTestDetails: s.release.hiddenTestDetails,
      reportedGrade: s.reportedGrade,
      allowedMaterials: s.allowedMaterials,
    },
    questions: arr(c.questions).map(toDraftQuestion),
  };
}

export const blankTest = (): DraftTest => ({ ...toDraft(undefined), questions: [] });

/** Text to a JSON value; `undefined` when empty, and a thrown message when it is not JSON. */
function parseJson(text: string, what: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Problem(`${what} must be valid JSON`);
  }
}
class Problem extends Error {}

const number = (text: string): number | undefined => {
  if (!text.trim()) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : Number.NaN;
};
/** File paths, one per line; blank lines and surrounding spaces are not paths. */
export const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
/** Program arguments, one per line, kept exactly as written. */
const argLines = (text: string) => (text === '' ? [] : text.split('\n'));

function checkContent(c: DraftCheck, at: string) {
  const files = lines(c.files);
  const base = {
    name: c.name,
    visibility: c.visibility,
    kind: c.kind,
    file: c.file,
    ...(files.length > 0 && { files }),
    points: number(c.points) ?? 1,
    ...(c.timeoutSeconds.trim() && { timeoutSeconds: number(c.timeoutSeconds) }),
    ...(c.stdin && { stdin: c.stdin }),
  };
  const tolerance = {
    ...(c.abs.trim() && { abs: number(c.abs) }),
    ...(c.rel.trim() && { rel: number(c.rel) }),
  };
  if (c.kind === 'script') {
    const args = argLines(c.args);
    return { ...base, ...(args.length > 0 && { args }) };
  }
  if (c.kind === 'stdio') {
    const args = argLines(c.args);
    return {
      ...base,
      ...(args.length > 0 && { args }),
      expected: {
        stdout: c.expectedStdout,
        ...(c.exitCode.trim() && { exitCode: number(c.exitCode) }),
      },
      compare: { mode: c.compareMode, ...tolerance },
    };
  }
  const args = parseJson(c.args, `${at} arguments`);
  if (args !== undefined && !Array.isArray(args)) {
    throw new Problem(`${at} arguments must be a JSON array`);
  }
  const kwargs = parseJson(c.kwargs, `${at} keyword arguments`);
  if (
    kwargs !== undefined &&
    (typeof kwargs !== 'object' || kwargs === null || Array.isArray(kwargs))
  ) {
    throw new Problem(`${at} keyword arguments must be a JSON object`);
  }
  const value =
    c.expects === 'value' ? parseJson(c.expectedValue, `${at} expected value`) : undefined;
  if (c.expects === 'value' && value === undefined) {
    throw new Problem(`${at} needs an expected value`);
  }
  return {
    ...base,
    function: c.fn,
    ...(args !== undefined && { args }),
    ...(kwargs !== undefined && { kwargs }),
    expected:
      c.expects === 'value'
        ? { value }
        : { raises: { type: c.raisesType, ...(c.raisesMessage && { message: c.raisesMessage }) } },
    compare: { mode: c.compareMode, ...tolerance },
  };
}

function questionContent(q: DraftQuestion, at: string) {
  const common = {
    id: q.id,
    kind: q.kind,
    prompt: q.prompt,
    points: number(q.points) ?? Number.NaN,
    rubric: q.rubric.map((r) => ({
      id: r.id,
      label: r.label,
      points: number(r.points) ?? Number.NaN,
    })),
  };
  if (q.kind === 'choice') {
    return {
      ...common,
      options: q.options.map((o) => ({ id: o.id, label: o.label })),
      multiple: q.multiple,
      correct: q.options.filter((o) => q.correct.includes(o.uid)).map((o) => o.id),
    };
  }
  if (q.kind === 'numeric') {
    return {
      ...common,
      answer: number(q.answer) ?? Number.NaN,
      tolerance: number(q.tolerance) ?? 0,
      ...(q.unit.trim() && { unit: q.unit.trim() }),
    };
  }
  if (q.kind === 'explanation') {
    return { ...common, maxLength: number(q.maxLength) ?? Number.NaN };
  }
  const limits = Object.fromEntries(
    (['wallSeconds', 'memoryMiB', 'outputBytes'] as const)
      .filter((k) => q.limits[k].trim())
      .map((k) => [k, number(q.limits[k])]),
  );
  return {
    ...common,
    runtime: q.runtime,
    files: q.files.map(({ uid: _uid, ...f }) => f),
    allowedPackages: q.allowedPackages,
    ...(Object.keys(limits).length > 0 && { limits }),
    checks: q.checks.map((c, i) => checkContent(c, `${at}, check ${i + 1}:`)),
  };
}

const settingsContent = (s: DraftSettings) => ({
  attempts: number(s.attempts) ?? Number.NaN,
  durationMinutes: number(s.durationMinutes) ?? null,
  opensAt: fromLocalInput(s.opensAt),
  closesAt: fromLocalInput(s.closesAt),
  timeZone: s.timeZone.trim(),
  late:
    s.late === 'accept'
      ? { policy: 'accept' as const, until: fromLocalInput(s.lateUntil) ?? '' }
      : { policy: 'none' as const },
  release: {
    results: s.releaseResults,
    at: s.releaseResults === 'scheduled' ? fromLocalInput(s.releaseAt) : null,
    solutions: s.solutions,
    hiddenTestDetails: s.hiddenTestDetails,
  },
  reportedGrade: s.reportedGrade,
  allowedMaterials: s.allowedMaterials,
});

/** `test.v1` content, or the message of the first value that is not valid JSON. */
export function toContent(draft: DraftTest): { content: unknown } | { problem: string } {
  try {
    return {
      content: {
        questions: draft.questions.map((q, i) => questionContent(q, `Question ${i + 1}`)),
        settings: settingsContent(draft.settings),
      },
    };
  } catch (err) {
    if (err instanceof Problem) return { problem: err.message };
    throw err;
  }
}

/** Why the form cannot be saved as a revision yet; empty when it can. */
export function problemsOf(draft: DraftTest): string[] {
  const built = toContent(draft);
  if ('problem' in built) return [built.problem];
  const parsed = testV1.safeParse(built.content);
  if (parsed.success) return [];
  return parsed.error.issues.slice(0, 6).map((issue) => describe(issue.path, issue.message, draft));
}

/** `questions.1.checks.0.name` as “Question 2, check 1, name”, so the message names the field. */
function describe(path: PropertyKey[], message: string, draft: DraftTest): string {
  const parts: string[] = [];
  for (let i = 0; i < path.length; i++) {
    const key = path[i];
    const next = path[i + 1];
    if (key === 'questions' && typeof next === 'number') {
      const id = draft.questions[next]?.id;
      parts.push(`Question ${next + 1}${id ? ` (${id})` : ''}`);
      i++;
    } else if (key === 'checks' && typeof next === 'number') {
      parts.push(`check ${next + 1}`);
      i++;
    } else if (typeof key === 'number') {
      parts.push(`item ${key + 1}`);
    } else parts.push(String(key));
  }
  return `${parts.join(', ') || 'Test'}: ${message}`;
}

export const limitBounds = RUNNER_BOUNDS;
export const settingDefaults = defaultAssignmentSettings;

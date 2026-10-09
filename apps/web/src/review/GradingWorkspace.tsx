import { type FormEvent, useState } from 'react';
import { ApiError } from '../api/client';
import buttons from '../components/Buttons.module.css';
import { Loading } from '../components/Loading';
import page from '../components/Page.module.css';
import { RetryNotice } from '../components/RetryNotice';
import styles from './Grading.module.css';
import {
  type AttemptGrade,
  conflictGrade,
  type FeedbackItem,
  type GradeRow,
  type InstructorRun,
  type ManualMark,
  overridePoints,
  points,
  previewRelease,
  type ReleasePreview,
  type ReviewedAttempt,
  regrade,
  release,
  SOURCE_LABEL,
  saveDraft,
  stamp,
  useAttemptGrade,
  useAttemptRuns,
  useRefreshGrades,
  useReviewedAttempt,
} from './grading';
import { useReleasePreviewFocus } from './useReleasePreviewFocus';

/** The question as the pinned revision holds it: only what the workspace shows is read. */
interface TestQuestion {
  id: string;
  kind: 'choice' | 'numeric' | 'explanation' | 'code';
  prompt: string;
  points: number;
  rubric: { id: string; label: string; points: number }[];
  options?: { id: string; label: string }[];
  unit?: string;
}

const questionsOf = (attempt: ReviewedAttempt): TestQuestion[] => {
  const list = (attempt.test as { questions?: unknown }).questions;
  return Array.isArray(list)
    ? (list as TestQuestion[]).map((q) => ({ ...q, rubric: q.rubric ?? [] }))
    : [];
};

/**
 * The grading workspace (§12): the submitted answers and execution results on one side, the
 * rubric, score and feedback on the other. Saving makes a draft only instructors see; releasing
 * is a separate action that names the recipient and the attempt first.
 */
export function GradingWorkspace({
  classId,
  attemptId,
  studentId,
  testTitle,
  cohort,
}: {
  classId: string;
  attemptId: string;
  /** The student whose work is open: an attempt of anyone else is not shown here. */
  studentId: string;
  testTitle: string;
  cohort: string;
}) {
  const grade = useAttemptGrade(classId, attemptId);
  const attempt = useReviewedAttempt(classId, attemptId);
  const runs = useAttemptRuns(classId, attemptId);
  const missing = [grade, attempt].some(
    (q) => q.error instanceof ApiError && q.error.status === 404,
  );
  if (missing) {
    return <p role="status">This attempt is not available in this class.</p>;
  }
  if (grade.isPending || attempt.isPending) {
    return <Loading label="Loading the attempt" className={page.intro} />;
  }
  if (!grade.data || !attempt.data) {
    return (
      <RetryNotice
        message="The attempt could not be loaded."
        onRetry={() => {
          void grade.refetch();
          void attempt.refetch();
        }}
      />
    );
  }
  if (grade.data.student.id !== studentId) {
    return (
      <p role="status">That attempt belongs to another student. Open one of the attempts above.</p>
    );
  }
  return (
    <Workspace
      // Everything inside (a release preview, an open change form, edits) belongs to one attempt.
      key={attemptId}
      classId={classId}
      grade={grade.data}
      attempt={attempt.data}
      runs={runs.data?.runs ?? null}
      runsFailed={runs.isError}
      testTitle={testTitle}
      cohort={cohort}
    />
  );
}

let lastKey = 0;
const nextKey = () => {
  lastKey += 1;
  return lastKey;
};

interface Form {
  manual: Record<string, { points: string; criteria: Record<string, string> }>;
  texts: Record<string, string>;
  extras: FeedbackItem[];
  lines: { key: number; questionId: string; path: string; line: string; text: string }[];
}

const keyOf = (target: FeedbackItem['target']) =>
  target.kind === 'attempt'
    ? 'attempt'
    : target.kind === 'question'
      ? `q:${target.questionId}`
      : null;

function initialForm(grade: AttemptGrade, questions: TestQuestion[]): Form {
  const current = grade.history[0];
  const form: Form = { manual: {}, texts: {}, extras: [], lines: [] };
  for (const q of current?.questions ?? grade.automated) {
    const manual = q.manual;
    if (!manual) continue;
    form.manual[q.questionId] = {
      points: manual.points !== null && manual.criteria.length === 0 ? points(manual.points) : '',
      criteria: Object.fromEntries(manual.criteria.map((c) => [c.id, points(c.points)])),
    };
  }
  for (const q of questions) form.manual[q.id] ??= { points: '', criteria: {} };
  for (const item of current?.feedback ?? []) {
    const key = keyOf(item.target);
    if (item.target.kind === 'line') {
      form.lines.push({
        key: nextKey(),
        questionId: item.target.questionId,
        path: item.target.path,
        line: String(item.target.line),
        text: item.text,
      });
    } else if (key && form.texts[key] === undefined) form.texts[key] = item.text;
    else form.extras.push(item);
  }
  return form;
}

/** What identifies the newest grade row as it stands: a release changes its state in place. */
const signature = (g: AttemptGrade) =>
  `${g.history[0]?.id ?? 'none'}:${g.history[0]?.state ?? ''}:${g.released?.id ?? ''}`;

type Draft =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

function Workspace({
  classId,
  grade: initial,
  attempt,
  runs,
  runsFailed,
  testTitle,
  cohort,
}: {
  classId: string;
  grade: AttemptGrade;
  attempt: ReviewedAttempt;
  runs: InstructorRun[] | null;
  runsFailed: boolean;
  testTitle: string;
  cohort: string;
}) {
  const refresh = useRefreshGrades(classId);
  const questions = questionsOf(attempt);
  const [grade, setGrade] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [form, setForm] = useState(() => initialForm(initial, questions));
  // A grade another writer saved or released while this form has unsaved edits.
  const [outside, setOutside] = useState<AttemptGrade | null>(null);
  const adopt = (next: AttemptGrade) => {
    setGrade(next);
    setForm(initialForm(next, questions));
    setDirty(false);
    setOutside(null);
  };
  // A grade this workspace did not write (another instructor, a release, a regrade run) replaces
  // the one shown, and the form restarts from it. A release changes the row's state in place.
  // Unsaved edits are never replaced silently: while there are any, the form stays and the
  // change is announced with the choice to load it. Only a grade that arrives while editing is
  // announced, never this workspace's own save waiting for its refetch.
  const [seen, setSeen] = useState(signature(initial));
  if (signature(initial) !== seen) {
    setSeen(signature(initial));
    if (signature(initial) !== signature(grade)) {
      if (dirty) setOutside(initial);
      else adopt(initial);
    }
  }
  const newer = outside?.history[0];
  // A release changes the newest row in place, so its id still matches and a save goes through.
  const refused = newer !== undefined && newer.id !== grade.history[0]?.id;
  const [draft, setDraft] = useState<Draft>({ kind: 'idle' });
  const current: GradeRow | undefined = grade.history[0];
  const base = current?.questions ?? grade.automated;
  const answerOf = new Map(attempt.answers.map((a) => [a.questionId, a]));
  const edit = (next: Form) => {
    setForm(next);
    setDirty(true);
    setDraft({ kind: 'idle' });
  };

  const body = (): { manual: ManualMark[]; feedback: FeedbackItem[]; problem?: string } => {
    const manual: ManualMark[] = [];
    for (const q of questions) {
      const entry = form.manual[q.id];
      const part = base.find((b) => b.questionId === q.id)?.manual;
      if (!entry || !part) continue;
      if (q.rubric.length > 0) {
        const criteria = q.rubric.flatMap((c) => {
          const raw = entry.criteria[c.id];
          if (raw === undefined || raw.trim() === '') return [];
          const value = Number(raw);
          return Number.isFinite(value) ? [{ id: c.id, points: value }] : [];
        });
        if (criteria.length > 0) manual.push({ questionId: q.id, criteria });
      } else if (entry.points.trim() !== '' && Number.isFinite(Number(entry.points))) {
        manual.push({ questionId: q.id, points: Number(entry.points) });
      }
    }
    const feedback: FeedbackItem[] = [];
    if (form.texts.attempt?.trim()) {
      feedback.push({ target: { kind: 'attempt' }, text: form.texts.attempt.trim() });
    }
    for (const q of questions) {
      const text = form.texts[`q:${q.id}`]?.trim();
      if (text) feedback.push({ target: { kind: 'question', questionId: q.id }, text });
    }
    feedback.push(...form.extras);
    for (const l of form.lines) {
      const line = Number(l.line);
      if (!l.text.trim()) {
        return {
          manual,
          feedback,
          problem: `The comment on ${l.path} line ${l.line} has no text. Write it or remove it.`,
        };
      }
      if (!Number.isInteger(line) || line < 1) {
        return { manual, feedback, problem: 'A line comment needs a line number of 1 or more.' };
      }
      feedback.push({
        target: { kind: 'line', questionId: l.questionId, path: l.path, line },
        text: l.text.trim(),
      });
    }
    return { manual, feedback };
  };

  const onConflict = (error: unknown) => {
    const found = conflictGrade(error);
    if (found === 'archived') return 'This class is archived, so grades can no longer change.';
    if (found === 'open') return 'This attempt has not been submitted, so it cannot be graded yet.';
    if (found) {
      // The edits were made on the old grade: start again from the latest one, never over it.
      adopt(found);
      return 'The grade changed since you opened it. The workspace now shows the latest grade; your edits were not saved.';
    }
    return null;
  };

  const save = async () => {
    const built = body();
    if (built.problem) return setDraft({ kind: 'error', message: built.problem });
    setDraft({ kind: 'saving' });
    try {
      const saved = await saveDraft(classId, attempt.id, {
        expectedGradeId: current?.id ?? null,
        manual: built.manual,
        feedback: built.feedback,
      });
      setGrade(saved);
      setDirty(false);
      setOutside(null);
      setDraft({ kind: 'saved' });
      void refresh();
    } catch (error) {
      setDraft({
        kind: 'error',
        message:
          onConflict(error) ??
          (error instanceof ApiError && error.status === 400
            ? 'The grade was not saved: a mark is outside its range or a text is empty.'
            : 'The draft grade was not saved. Your edits are still here.'),
      });
    }
  };

  const released = grade.released;
  const newerDraft = current && current.state === 'draft' && released !== null;
  const status =
    draft.kind === 'saved'
      ? 'Draft saved. The student cannot see it until you release it.'
      : draft.kind === 'saving'
        ? 'Saving…'
        : dirty
          ? 'Unsaved changes. Save the draft before releasing.'
          : 'Student cannot see draft feedback.';

  return (
    <section className={styles.work} aria-label="Grading workspace">
      <div className={page.row}>
        <div>
          <div className={`${page.small} ${page.muted}`}>
            {cohort} · {testTitle} · Attempt {attempt.number}
            {attempt.submittedAt
              ? ` · submitted ${stamp(attempt.submittedAt)}`
              : ' · not submitted'}
            {attempt.receipt?.late ? ' · late' : ''}
          </div>
        </div>
      </div>
      {outside ? (
        <div className={page.row} role="alert">
          <span className={page.small}>
            The grade changed while you were editing
            {newer
              ? `: grade ${newer.number} · ${newer.state === 'released' ? 'Released' : SOURCE_LABEL[newer.source]}, ${points(newer.points)} / ${points(newer.possible)}`
              : ''}
            . Your unsaved edits are still here
            {refused ? ', and saving them will be refused.' : '.'}
          </span>
          <button type="button" className={buttons.textButton} onClick={() => adopt(outside)}>
            Load latest grade
          </button>
        </div>
      ) : null}
      {released ? (
        <p className={page.small}>
          Released to {grade.student.name}: {points(released.points)} / {points(released.possible)}
          {released.releasedAt ? ` on ${stamp(released.releasedAt)}` : ''}.
          {newerDraft
            ? ` A newer ${SOURCE_LABEL[current.source].toLowerCase()} (${points(current.points)} / ${points(current.possible)}) is a draft the student does not see until you release it.`
            : ''}
        </p>
      ) : null}
      <div className={styles.split}>
        <div>
          {attempt.localCopy ? (
            <p className={`${page.small} ${page.muted}`}>
              The student kept unsent work from their browser. It is not part of the submission.
            </p>
          ) : null}
          {questions.map((q, i) => (
            <QuestionBlock
              key={q.id}
              n={i + 1}
              question={q}
              answer={answerOf.get(q.id)?.value}
              score={base.find((b) => b.questionId === q.id)}
              runs={runs}
              runsFailed={runsFailed}
              lines={form.lines.filter((l) => l.questionId === q.id)}
              onLine={(next) =>
                edit({
                  ...form,
                  lines: [...form.lines.filter((l) => l.questionId !== q.id), ...next],
                })
              }
            />
          ))}
        </div>
        <aside className={styles.rubric} aria-label="Rubric, score and feedback">
          <div className={`${page.small} ${page.muted}`}>
            Rubric / {released && !newerDraft ? 'released' : 'draft'} feedback
          </div>
          {questions.map((q, i) => (
            <RubricBlock
              key={q.id}
              n={i + 1}
              question={q}
              score={base.find((b) => b.questionId === q.id)}
              entry={form.manual[q.id]}
              text={form.texts[`q:${q.id}`] ?? ''}
              onEntry={(entry) => edit({ ...form, manual: { ...form.manual, [q.id]: entry } })}
              onText={(text) => edit({ ...form, texts: { ...form.texts, [`q:${q.id}`]: text } })}
            />
          ))}
          <p>
            <strong>
              Total {current ? points(current.points) : '—'} /{' '}
              {current
                ? points(current.possible)
                : points(base.reduce((n, b) => n + b.possible, 0))}
            </strong>
            {current && !current.complete ? ' · incomplete: some questions have no points' : ''}
            {current?.override ? ' · overridden' : ''}
          </p>
          <label htmlFor="pc-feedback-attempt">Feedback to {grade.student.name}</label>
          <textarea
            id="pc-feedback-attempt"
            rows={4}
            value={form.texts.attempt ?? ''}
            onChange={(e) => edit({ ...form, texts: { ...form.texts, attempt: e.target.value } })}
          />
          <div className={styles.stack}>
            <button
              type="button"
              className={buttons.outline}
              onClick={() => void save()}
              disabled={draft.kind === 'saving' || (!dirty && current !== undefined)}
            >
              Save draft grade
            </button>
            <ReleaseControl
              classId={classId}
              grade={grade}
              attemptId={attempt.id}
              attemptNumber={attempt.number}
              testTitle={testTitle}
              blocked={dirty}
              onReleased={() => void refresh()}
            />
            <span
              className={`${page.small} ${draft.kind === 'saved' ? styles.success : page.muted}`}
              role="status"
            >
              {status}
            </span>
            {draft.kind === 'error' ? (
              <span className={`${page.small} ${styles.error}`} role="alert">
                {draft.message}
              </span>
            ) : null}
          </div>
          <ChangeGrade
            classId={classId}
            grade={grade}
            attemptId={attempt.id}
            blocked={dirty}
            onGrade={(next) => {
              adopt(next);
              void refresh();
            }}
            onConflict={onConflict}
          />
          <History rows={grade.history} />
        </aside>
      </div>
    </section>
  );
}

function QuestionBlock({
  n,
  question,
  answer,
  score,
  runs,
  runsFailed,
  lines,
  onLine,
}: {
  n: number;
  question: TestQuestion;
  answer: unknown;
  score: AttemptGrade['automated'][number] | undefined;
  runs: InstructorRun[] | null;
  runsFailed: boolean;
  lines: Form['lines'];
  onLine: (lines: Form['lines']) => void;
}) {
  const auto = score?.automated;
  return (
    <div className={styles.question}>
      <div className={`${page.small} ${page.muted}`}>
        Question {n} · {question.kind} · {points(question.points)} points
      </div>
      <p>{question.prompt}</p>
      <Answer question={question} answer={answer} lines={lines} onLine={onLine} />
      {auto ? (
        <p className={page.small}>
          Automated:{' '}
          {auto.status === 'scored' && auto.points !== null
            ? `${points(auto.points)} / ${points(auto.possible)}`
            : auto.status === 'pending'
              ? 'no result yet; grading has not finished'
              : 'grading failed on the runner; replay or override it'}
        </p>
      ) : null}
      {question.kind === 'code' ? (
        <Execution runs={runs} failed={runsFailed} questionId={question.id} />
      ) : null}
    </div>
  );
}

function Answer({
  question,
  answer,
  lines,
  onLine,
}: {
  question: TestQuestion;
  answer: unknown;
  lines: Form['lines'];
  onLine: (lines: Form['lines']) => void;
}) {
  if (answer === undefined || answer === null || answer === '') {
    return <p className={page.muted}>No answer was submitted.</p>;
  }
  if (question.kind === 'choice') {
    const chosen = new Set(Array.isArray(answer) ? answer : [answer]);
    const labels = (question.options ?? []).filter((o) => chosen.has(o.id)).map((o) => o.label);
    return <p>Chosen: {labels.length > 0 ? labels.join(', ') : 'nothing'}</p>;
  }
  if (question.kind === 'numeric') {
    return (
      <p>
        Answer: {String(answer)}
        {question.unit ? ` ${question.unit}` : ''}
      </p>
    );
  }
  if (question.kind === 'explanation') return <div className={styles.prose}>{String(answer)}</div>;
  const files = (answer as { files?: { path: string; content: string }[] }).files ?? [];
  return (
    <>
      {files.map((file) => (
        <CodeFile
          key={file.path}
          file={file}
          lines={lines.filter((l) => l.path === file.path)}
          onLines={(next) => onLine([...lines.filter((l) => l.path !== file.path), ...next])}
          questionId={question.id}
        />
      ))}
    </>
  );
}

/** A code file with numbered lines; a comment can be attached to any line (§11). */
function CodeFile({
  file,
  lines,
  onLines,
  questionId,
}: {
  file: { path: string; content: string };
  lines: Form['lines'];
  onLines: (lines: Form['lines']) => void;
  questionId: string;
}) {
  const [line, setLine] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const rows = file.content.split('\n');
  return (
    <div>
      <div className={`${page.small} ${page.muted}`}>{file.path}</div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region needs a tab stop */}
      {/* biome-ignore lint/a11y/useSemanticElements: the code keeps its <pre> semantics; the role names the tab stop */}
      <pre tabIndex={0} role="region" aria-label={`Code of ${file.path}`}>
        {rows.map((text, i) => (
          // The file is fixed text, so the line number is the identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: lines of a frozen file
          <span key={i} className={styles.line}>
            <span className={styles.lineNo}>{i + 1}</span>
            {text}
          </span>
        ))}
      </pre>
      {lines.map((l, i) => (
        <div key={l.key} className={styles.criterion}>
          <label>
            Comment on {file.path} line {l.line}
            <input
              type="text"
              value={l.text}
              onChange={(e) =>
                onLines(lines.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))
              }
            />
          </label>
          <button
            type="button"
            className={buttons.textButton}
            onClick={() => onLines(lines.filter((_, j) => j !== i))}
          >
            Remove comment on line {l.line}
          </button>
        </div>
      ))}
      <div className={styles.criterion}>
        <label>
          Line to comment on
          <input
            type="number"
            min={1}
            max={rows.length}
            value={line}
            onChange={(e) => setLine(e.target.value)}
          />
        </label>
        <button
          type="button"
          className={buttons.textButton}
          disabled={!line}
          onClick={() => {
            const n = Number(line);
            if (!Number.isInteger(n) || n < 1 || n > rows.length) {
              setProblem(`${file.path} has lines 1 to ${rows.length}.`);
              return;
            }
            setProblem(null);
            onLines([...lines, { key: nextKey(), questionId, path: file.path, line, text: '' }]);
            setLine('');
          }}
        >
          Add line comment
        </button>
      </div>
      {problem ? (
        <span className={`${page.small} ${styles.error}`} role="alert">
          {problem}
        </span>
      ) : null}
    </div>
  );
}

interface CheckView {
  name: string;
  status: string;
  message?: string;
  expected?: string;
  actual?: string;
}

const checksOf = (run: InstructorRun): CheckView[] => {
  const result = (run.result?.outcome as { result?: { checks?: CheckView[] } } | undefined)?.result;
  return Array.isArray(result?.checks) ? result.checks : [];
};

const RUN_STATE: Record<string, string> = {
  queued: 'queued',
  running: 'running',
  passed: 'all checks passed',
  failed: 'some checks failed',
  time_limited: 'ran out of time',
  resource_exhausted: 'ran out of memory or output',
  cancelled: 'cancelled',
  infrastructure_error: 'could not run: runner failure',
};

/** The newest grading, replay or regrade run with all checks (hidden ones included) for a question. */
function Execution({
  runs,
  failed,
  questionId,
}: {
  runs: InstructorRun[] | null;
  failed: boolean;
  questionId: string;
}) {
  if (failed) return <p className={page.small}>Execution results could not be loaded.</p>;
  if (!runs) return <p className={page.small}>Loading execution results…</p>;
  const full = runs
    .filter((r) => r.questionId === questionId && r.checkSet === 'full')
    .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
  const run = full.find((r) => r.supersededBy === null) ?? full[0];
  if (!run) return <p className={page.small}>No grading run has started for this question.</p>;
  const checks = checksOf(run);
  return (
    <div>
      <p className={page.small}>
        Execution result: {RUN_STATE[run.state] ?? run.state} · {run.reason} run · grader{' '}
        {run.graderVersion}
        {run.failure ? ` · ${run.failure.message}` : ''}
      </p>
      {checks.length > 0 ? (
        <ul className={styles.checks} aria-label="Check results">
          {checks.map((c) => (
            <li key={c.name}>
              {c.name}: {c.status}
              {c.message ? ` · ${c.message}` : ''}
              {c.status !== 'passed' && c.expected !== undefined
                ? ` · expected ${c.expected}, received ${c.actual ?? 'nothing'}`
                : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function RubricBlock({
  n,
  question,
  score,
  entry,
  text,
  onEntry,
  onText,
}: {
  n: number;
  question: TestQuestion;
  score: AttemptGrade['automated'][number] | undefined;
  entry: Form['manual'][string] | undefined;
  text: string;
  onEntry: (entry: Form['manual'][string]) => void;
  onText: (text: string) => void;
}) {
  const manual = score?.manual;
  const current = entry ?? { points: '', criteria: {} };
  return (
    <fieldset>
      <legend className={page.small}>
        Question {n}: {score?.points !== null && score ? `${points(score.points ?? 0)} / ` : ''}
        {points(question.points)}
      </legend>
      {score?.automated ? (
        <div className={`${page.row} ${page.between} ${page.small}`}>
          <span>Automated</span>
          <span>
            {score.automated.points !== null ? points(score.automated.points) : '—'} /{' '}
            {points(score.automated.possible)}
          </span>
        </div>
      ) : null}
      {manual && question.rubric.length > 0 ? (
        question.rubric.map((c) => (
          <div key={c.id} className={styles.criterion}>
            <label>
              {c.label}
              <input
                type="number"
                min={0}
                max={c.points}
                step="any"
                value={current.criteria[c.id] ?? ''}
                onChange={(e) =>
                  onEntry({ ...current, criteria: { ...current.criteria, [c.id]: e.target.value } })
                }
              />
            </label>
            <span className={page.small}>/ {points(c.points)}</span>
          </div>
        ))
      ) : manual ? (
        <div className={styles.criterion}>
          <label>
            Points for question {n}
            <input
              type="number"
              min={0}
              max={manual.possible}
              step="any"
              value={current.points}
              onChange={(e) => onEntry({ ...current, points: e.target.value })}
            />
          </label>
          <span className={page.small}>/ {points(manual.possible)}</span>
        </div>
      ) : null}
      <label>
        Feedback on question {n}
        <textarea rows={2} value={text} onChange={(e) => onText(e.target.value)} />
      </label>
    </fieldset>
  );
}

type Release =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'preview'; preview: ReleasePreview; note?: string }
  | { kind: 'sending'; preview: ReleasePreview }
  | { kind: 'done'; at: string; name: string }
  | { kind: 'error'; message: string };

const SKIPPED: Record<ReleasePreview['skipped'][number]['reason'], string> = {
  not_found: 'This attempt was not found.',
  no_grade: 'There is no grade to release.',
  already_released: 'The newest grade is already released.',
  incomplete: 'Some questions have no points. Mark them or override the grade first.',
};

/** Release feedback: previews the recipient and the attempt, then asks for confirmation. */
function ReleaseControl({
  classId,
  grade,
  attemptId,
  attemptNumber,
  testTitle,
  blocked,
  onReleased,
}: {
  classId: string;
  grade: AttemptGrade;
  attemptId: string;
  attemptNumber: number;
  testTitle: string;
  blocked: boolean;
  onReleased: () => void;
}) {
  const [state, setState] = useState<Release>({ kind: 'idle' });
  const { trigger, heading, result } = useReleasePreviewFocus<HTMLSpanElement>(state.kind);
  const previewTitle =
    state.kind === 'preview' || state.kind === 'sending'
      ? state.preview.recipients.length === 0
        ? 'Nothing to release'
        : `Release to ${state.preview.recipients.map((r) => r.student.name).join(', ')}`
      : '';
  const current = grade.history[0];
  const releasable = current !== undefined && current.state === 'draft' && current.complete;
  const why = blocked
    ? 'Save the draft first.'
    : !current
      ? 'Save a grade first.'
      : current.state === 'released'
        ? 'The newest grade is already released.'
        : !current.complete
          ? 'Mark every question or override the grade first.'
          : null;
  const open = async () => {
    setState({ kind: 'loading' });
    try {
      setState({ kind: 'preview', preview: await previewRelease(classId, [attemptId]) });
    } catch {
      setState({ kind: 'error', message: 'The release preview could not be loaded.' });
    }
  };
  const confirm = async (preview: ReleasePreview) => {
    setState({ kind: 'sending', preview });
    try {
      const done = await release(
        classId,
        preview.recipients.map((r) => ({ attemptId: r.attemptId, gradeId: r.gradeId })),
      );
      setState({ kind: 'done', at: done.releasedAt, name: grade.student.name });
      onReleased();
    } catch (error) {
      const body =
        error instanceof ApiError
          ? (error.body as { error?: string; preview?: ReleasePreview })
          : null;
      if (body?.error === 'release_changed' && body.preview) {
        setState({
          kind: 'preview',
          preview: body.preview,
          note: 'The grade changed, so nothing was released. This is what a release would do now.',
        });
        onReleased();
      } else {
        setState({ kind: 'error', message: 'Nothing was released. Try again.' });
      }
    }
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={buttons.primary}
        disabled={!releasable || blocked || state.kind === 'loading'}
        title={why ?? undefined}
        onClick={() => void open()}
      >
        {current?.state === 'released' ? 'Feedback released' : 'Release feedback'}
      </button>
      {why && current?.state !== 'released' ? (
        <span className={`${page.small} ${page.muted}`}>{why}</span>
      ) : null}
      <span className={styles.srOnly} aria-live="polite">
        {state.kind === 'preview'
          ? `${state.note ? `${state.note} ` : ''}Release preview: ${state.preview.recipients.length} to release, ${state.preview.skipped.length} not released.`
          : ''}
      </span>
      {state.kind === 'preview' || state.kind === 'sending' ? (
        <section className={styles.preview} aria-label="Release preview">
          {state.kind === 'preview' && state.note ? <p>{state.note}</p> : null}
          <h3 className={styles.previewHeading} tabIndex={-1} ref={heading}>
            {previewTitle}
          </h3>
          <ul>
            {state.preview.recipients.map((r) => (
              <li key={r.gradeId}>
                {r.student.name} · {testTitle} · Attempt {r.attemptNumber || attemptNumber} · grade{' '}
                {r.gradeNumber}: {points(r.points)} / {points(r.possible)}
              </li>
            ))}
            {state.preview.skipped.map((s) => (
              <li key={s.attemptId}>{SKIPPED[s.reason]}</li>
            ))}
          </ul>
          {blocked ? (
            <p className={page.small} role="alert">
              You changed the grade after this preview. Save the draft, then preview again.
            </p>
          ) : null}
          <div className={page.row}>
            <button
              type="button"
              className={buttons.primary}
              disabled={
                state.kind === 'sending' || state.preview.recipients.length === 0 || blocked
              }
              onClick={() => void confirm(state.preview)}
            >
              {state.kind === 'sending'
                ? 'Releasing…'
                : `Confirm release to ${state.preview.recipients.length} ${state.preview.recipients.length === 1 ? 'student' : 'students'}`}
            </button>
            <button
              type="button"
              className={buttons.textButton}
              onClick={() => setState({ kind: 'idle' })}
              disabled={state.kind === 'sending'}
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}
      {state.kind === 'done' ? (
        <span
          className={`${page.small} ${styles.success}`}
          role="status"
          tabIndex={-1}
          ref={result}
        >
          Released to {state.name} on {stamp(state.at)}.
        </span>
      ) : null}
      {state.kind === 'error' ? (
        <span className={`${page.small} ${styles.error}`} role="alert" tabIndex={-1} ref={result}>
          {state.message}
        </span>
      ) : null}
    </>
  );
}

/** Override or regrade: both need a reason, and the prior result stays in the history. */
function ChangeGrade({
  classId,
  grade,
  attemptId,
  blocked,
  onGrade,
  onConflict,
}: {
  classId: string;
  grade: AttemptGrade;
  attemptId: string;
  /** Unsaved edits would be replaced by the new grade: save them first. */
  blocked: boolean;
  onGrade: (grade: AttemptGrade) => void;
  onConflict: (error: unknown) => string | null;
}) {
  const current = grade.history[0];
  const [mode, setMode] = useState<'override' | 'regrade' | null>(null);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!current) return null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setMessage(null);
    setBusy(true);
    try {
      const next =
        mode === 'override'
          ? await overridePoints(classId, attemptId, {
              expectedGradeId: current.id,
              points: Number(value),
              reason,
            })
          : await regrade(classId, attemptId, { expectedGradeId: current.id, reason });
      setMode(null);
      setValue('');
      setReason('');
      onGrade(next);
    } catch (error) {
      setMessage(onConflict(error) ?? 'The change was not saved. Check the points and the reason.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.stack}>
      <div className={page.row}>
        <button
          type="button"
          className={buttons.textButton}
          disabled={blocked}
          onClick={() => setMode('override')}
        >
          Override grade
        </button>
        <button
          type="button"
          className={buttons.textButton}
          disabled={blocked}
          onClick={() => setMode('regrade')}
        >
          Regrade from latest results
        </button>
      </div>
      {blocked ? (
        <span className={`${page.small} ${page.muted}`}>
          Save the draft first: an override or regrade replaces unsaved edits.
        </span>
      ) : null}
      {mode ? (
        <form
          onSubmit={(e) => void submit(e)}
          aria-label={mode === 'override' ? 'Override grade' : 'Regrade'}
        >
          {mode === 'override' ? (
            <label>
              Points of {points(current.possible)}
              <input
                type="number"
                min={0}
                max={current.possible}
                step="any"
                required
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
          ) : null}
          <label>
            Reason
            <input
              type="text"
              required
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <p className={`${page.small} ${page.muted}`}>
            The original result is kept in the history below.
          </p>
          <div className={page.row}>
            <button type="submit" className={buttons.outline} disabled={busy || blocked}>
              {mode === 'override' ? 'Save override as draft' : 'Save regrade as draft'}
            </button>
            <button type="button" className={buttons.textButton} onClick={() => setMode(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {message ? (
        <span className={`${page.small} ${styles.error}`} role="alert">
          {message}
        </span>
      ) : null}
    </div>
  );
}

/** Saved grades, regrades, overrides and releases stay distinguishable (§11). */
function History({ rows }: { rows: GradeRow[] }) {
  if (rows.length === 0) return null;
  return (
    <details>
      <summary>Grade history ({rows.length})</summary>
      <ul className={styles.history} aria-label="Grade history">
        {rows.map((r) => (
          <li key={r.id}>
            Grade {r.number} · {SOURCE_LABEL[r.source]} · {points(r.points)} / {points(r.possible)}{' '}
            · {r.state === 'released' && r.releasedAt ? `released ${stamp(r.releasedAt)}` : 'draft'}
            {r.reason ? ` · ${r.reason}` : ''}
            {r.override ? ` · override of grade ${points(r.override.points)} points` : ''} ·
            automated {points(r.automatedPoints)} · manual {points(r.manualPoints)}
          </li>
        ))}
      </ul>
    </details>
  );
}

import { useEffect, useRef } from 'react';
import { ApiError } from '../api/client';
import buttons from '../components/Buttons.module.css';
import { Loading } from '../components/Loading';
import { RetryNotice } from '../components/RetryNotice';
import { type MyResults, type ResultAttempt, type ResultQuestion, useResultDetail } from './api';
import styles from './Test.module.css';

type Grade = NonNullable<ResultAttempt['grade']>;
type Feedback = Grade['feedback'][number];

const points = (earned: number, possible: number) => `${earned} of ${possible} points`;

const RULE: Record<MyResults['rule'], string> = {
  latest: 'latest attempt',
  highest: 'highest-scoring attempt',
  instructor_selected: 'attempt your instructor chose',
};

/**
 * One line of state for an attempt (§11). A score of zero, an attempt not yet submitted and a
 * grading failure each have their own wording: none of them reads as another.
 */
export function resultLine(a: ResultAttempt): string {
  if (a.status === 'released' && a.grade)
    return `Result: ${points(a.grade.points, a.grade.possible)}`;
  if (a.status === 'in_progress') return 'Not submitted yet';
  switch (a.state) {
    case 'needs_review':
      return 'Grading could not finish. Your instructor will review it; no score has been recorded.';
    case 'graded':
      return 'Graded · your instructor has not released the result yet';
    case 'released':
      return 'Result released';
    default:
      return 'Submitted · not graded yet';
  }
}

/** The grade the assignment's rule reports, once any attempt's result is released. */
export function ReportedGrade({ results }: { results: MyResults }) {
  if (!results.reported) return null;
  return (
    <p role="status" className={styles.statusLine}>
      Reported grade: {points(results.reported.points, results.reported.possible)} (
      {RULE[results.rule]})
    </p>
  );
}

function FeedbackNote({ item }: { item: Feedback }) {
  return (
    <p className={styles.feedbackNote}>
      <strong>Instructor feedback:</strong> {item.text}
    </p>
  );
}

function Answer({ q }: { q: ResultQuestion }) {
  if (q.answer === null || q.answer === undefined || q.answer === '') {
    return <p className={styles.muted}>You left this question unanswered.</p>;
  }
  const label = (id: string) => q.options?.find((o) => o.id === id)?.label ?? id;
  if (q.kind === 'choice') {
    const ids = Array.isArray(q.answer) ? (q.answer as string[]) : [];
    return <p className={styles.answerBox}>{ids.map(label).join(', ')}</p>;
  }
  if (q.kind === 'numeric') {
    return (
      <p className={styles.answerBox}>
        {String(q.answer)}
        {q.unit ? ` ${q.unit}` : ''}
      </p>
    );
  }
  return <p className={styles.answerBox}>{String(q.answer)}</p>;
}

function Solution({ q }: { q: ResultQuestion }) {
  if (!q.solution) return null;
  const label = (id: string) => q.options?.find((o) => o.id === id)?.label ?? id;
  const text = q.solution.correct
    ? q.solution.correct.map(label).join(', ')
    : `${q.solution.value}${q.unit ? ` ${q.unit}` : ''}${
        q.solution.tolerance ? ` (± ${q.solution.tolerance})` : ''
      }`;
  return (
    <p>
      <strong>Correct answer:</strong> {text}
    </p>
  );
}

function CodeAnswer({ q, lineFeedback }: { q: ResultQuestion; lineFeedback: Feedback[] }) {
  if (!q.code) return null;
  return (
    <>
      {q.code.files.map((file) => (
        <div key={file.path}>
          <p className={styles.small}>
            <strong>{file.path}</strong>
          </p>
          <ol className={styles.codeLines} aria-label={`Your code in ${file.path}`}>
            {file.content.split('\n').map((text, i) => {
              const line = i + 1;
              const notes = lineFeedback.filter(
                (f) =>
                  f.target.kind === 'line' && f.target.path === file.path && f.target.line === line,
              );
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: a file's lines have no other identity.
                <li key={i}>
                  <span>{line}</span>
                  <pre>{text || ' '}</pre>
                  {notes.map((n) => (
                    <FeedbackNote key={n.text} item={n} />
                  ))}
                </li>
              );
            })}
          </ol>
        </div>
      ))}
      <h4>Checks</h4>
      <p>
        {q.code.checkTotals.passed} of {q.code.checkTotals.total} checks passed
        {q.code.checks.length < q.code.checkTotals.total
          ? '. Details of the remaining checks are not shown for this test.'
          : '.'}
      </p>
      <ul className={styles.checks}>
        {q.code.checks.map((c) => (
          <li key={c.name}>
            <strong>{c.name}</strong> · {c.visibility === 'hidden' ? 'hidden check · ' : ''}
            {c.status === 'passed' ? 'Passed' : 'Not passed'}
            {c.message ? <div className={styles.small}>{c.message}</div> : null}
            {c.status !== 'passed' && c.expected !== undefined ? (
              <div className={styles.small}>
                Expected {JSON.stringify(c.expected)}
                {c.actual !== undefined ? `, got ${JSON.stringify(c.actual)}` : ''}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

function QuestionResult({ index, q, grade }: { index: number; q: ResultQuestion; grade: Grade }) {
  const score = grade.questions.find((s) => s.questionId === q.questionId);
  const mine = grade.feedback.filter(
    (f) => 'questionId' in f.target && f.target.questionId === q.questionId,
  );
  const ofQuestion = mine.filter((f) => f.target.kind === 'question');
  const ofLines = mine.filter((f) => f.target.kind === 'line');
  return (
    <section className={styles.question} aria-labelledby={`pc-result-${q.questionId}`}>
      <h3 id={`pc-result-${q.questionId}`}>
        Question {index + 1} ·{' '}
        {score?.points === null || score === undefined
          ? `of ${q.possible} points`
          : points(score.points, q.possible)}
      </h3>
      <p>{q.prompt}</p>
      <h4>Your answer</h4>
      {q.kind === 'code' ? <CodeAnswer q={q} lineFeedback={ofLines} /> : <Answer q={q} />}
      <Solution q={q} />
      {score && score.criteria.length > 0 ? (
        <ul className={styles.checks} aria-label="Rubric">
          {score.criteria.map((c) => {
            const rubric = q.rubric.find((r) => r.id === c.id);
            return (
              <li key={c.id}>
                {rubric?.label ?? c.id}: {c.points}
                {rubric ? ` of ${rubric.points}` : ''}
              </li>
            );
          })}
        </ul>
      ) : null}
      {ofQuestion.map((f) => (
        <FeedbackNote key={f.text} item={f} />
      ))}
    </section>
  );
}

/** A released attempt (§11): points, rubric, the feedback attached where the instructor put it. */
export function ResultsView({
  classId,
  title,
  attempt,
  onBack,
}: {
  classId: string;
  title: string;
  attempt: ResultAttempt;
  onBack: () => void;
}) {
  const detail = useResultDetail(classId, attempt.attemptId);
  const heading = useRef<HTMLHeadingElement>(null);
  const grade = attempt.grade;
  useEffect(() => heading.current?.focus(), []);
  if (!grade) return null;
  const wholeAttempt = grade.feedback.filter((f) => f.target.kind === 'attempt');
  return (
    <div className={styles.stage}>
      <p>
        <button type="button" className={buttons.textButton} onClick={onBack}>
          Back to attempts
        </button>
      </p>
      <h2 ref={heading} tabIndex={-1} style={{ margin: '0 0 8px', font: 'var(--pc-text-section)' }}>
        {title} · attempt {attempt.number} feedback
      </h2>
      <p className={styles.score}>{points(grade.points, grade.possible)}</p>
      {grade.overridden ? (
        <p className={`${styles.small} ${styles.muted}`}>
          Your instructor adjusted this score after grading.
        </p>
      ) : null}
      {wholeAttempt.map((f) => (
        <FeedbackNote key={f.text} item={f} />
      ))}
      {detail.data ? (
        detail.data.questions.map((q, i) => (
          <QuestionResult key={q.questionId} index={i} q={q} grade={grade} />
        ))
      ) : detail.error instanceof ApiError && detail.error.status === 404 ? (
        <p>The details of this attempt are not available.</p>
      ) : detail.isError ? (
        <RetryNotice
          message="The questions and your answers could not be loaded."
          onRetry={() => void detail.refetch()}
        />
      ) : (
        <Loading label="Loading your answers" className={styles.small} />
      )}
    </div>
  );
}

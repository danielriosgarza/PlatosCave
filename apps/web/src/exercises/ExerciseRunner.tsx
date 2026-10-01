import { useState } from 'react';
import { type Attempt, type AttemptStep, useAttempt, useAttemptActions } from './attempt';
import styles from './Exercise.module.css';
import { type Draft, initialDraft, StepForm, toResponse } from './StepForm';

const HELP_LABEL = {
  independent: 'independently',
  with_hints: 'with hints',
  solution_shown: 'with the solution shown',
} as const;

const SAVES_TEXT = new Set(['text', 'code']);

/** One practice attempt: the active step, its feedback, and the summary once complete (§9). */
export function ExerciseRunner({
  classId,
  resourceId,
  title,
}: {
  classId: string;
  resourceId: string;
  title: string;
}) {
  const query = useAttempt(classId, resourceId);
  // Kept here: a stale tab moves to an attempt with another id, which remounts the keyed view.
  const [notice, setNotice] = useState<string | null>(null);
  if (query.isError) {
    return (
      <p className={styles.inlineError} role="alert">
        This exercise could not be opened. It may not be open to you yet.
      </p>
    );
  }
  if (!query.data) return <p role="status">Opening exercise</p>;
  return (
    <PracticeAttempt
      key={query.data.id}
      classId={classId}
      resourceId={resourceId}
      title={title}
      attempt={query.data}
      notice={notice}
      setNotice={setNotice}
    />
  );
}

function PracticeAttempt({
  classId,
  resourceId,
  title,
  attempt,
  notice,
  setNotice,
}: {
  classId: string;
  resourceId: string;
  title: string;
  attempt: Attempt;
  notice: string | null;
  setNotice: (notice: string | null) => void;
}) {
  const actions = useAttemptActions(classId, resourceId, attempt, setNotice);
  const steps = attempt.steps;
  // The step on show. It stays put when its check completes, so the feedback can be read;
  // Continue moves on. A reopened attempt starts at the first step still open.
  const [index, setIndex] = useState(() => {
    const open = steps.findIndex((s) => s.status === 'pending');
    return open === -1 ? steps.length : open;
  });
  const step = steps[index];
  const last = steps.length - 1;
  // The summary follows an explicit step from the last one, so its feedback and any revealed
  // solution can be read first; an attempt reopened complete starts there.
  const summary = !step;
  const done = steps.filter((s) => s.status === 'completed').length;

  return (
    <section className={styles.stage} aria-label={`Exercise ${title}`}>
      <div className={styles.exercise}>
        <div className={styles.stepLabel}>
          {summary
            ? `${steps.length} of ${steps.length} steps complete`
            : `${index + 1} · ${step?.title}`}
        </div>
        <ol
          className={styles.track}
          aria-label={
            summary
              ? 'Exercise complete'
              : `Exercise step ${index + 1} of ${steps.length}: ${step?.title}; ${done} complete`
          }
        >
          {steps.map((s, i) => (
            <li key={s.id} data-done={s.status === 'completed' || i <= index} />
          ))}
        </ol>
        {notice && (
          <p className={styles.notice} role="status">
            {notice}
          </p>
        )}
        {summary ? (
          <Summary
            attempt={attempt}
            busy={actions.busy}
            // The new attempt has its own id, which remounts this view at its first step.
            onRestart={() => void actions.restart()}
          />
        ) : (
          <StepPanel
            key={`${attempt.id}:${step.id}`}
            step={step}
            isLast={index === last}
            actions={actions}
            onContinue={() => setIndex(index + 1)}
          />
        )}
        {actions.error && (
          <p className={styles.inlineError} role="alert">
            {actions.error}
          </p>
        )}
      </div>
    </section>
  );
}

type Actions = ReturnType<typeof useAttemptActions>;

function StepPanel({
  step,
  isLast,
  actions,
  onContinue,
}: {
  step: AttemptStep;
  isLast: boolean;
  actions: Actions;
  onContinue: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(step));
  const [problem, setProblem] = useState<string | null>(null);
  const [hintsOpen, setHintsOpen] = useState(true);
  const completed = step.status === 'completed';
  const writes = SAVES_TEXT.has(step.kind);

  const submit = async () => {
    const built = toResponse(step, draft);
    if (!built.ok) {
      setProblem(built.message);
      return;
    }
    setProblem(null);
    if (writes) await actions.complete({ stepId: step.id, response: built.response as string });
    else await actions.check({ stepId: step.id, response: built.response });
  };
  const change = (next: Draft) => {
    setDraft(next);
    setProblem(null);
    actions.clearError();
  };

  const primary = writes
    ? step.kind === 'code'
      ? 'Save code'
      : 'Done'
    : step.kind === 'simulation'
      ? 'Record this value'
      : 'Check answer';
  const moreHints = step.hints.length < step.hintCount;
  const showSolution = step.hasSolution && !completed;

  return (
    <div>
      <div className={styles.head}>
        <h3>{step.title}</h3>
        <p className={styles.prompt}>{step.prompt}</p>
      </div>
      <StepForm step={step} draft={draft} disabled={completed || actions.busy} onChange={change} />
      <div className={styles.actions}>
        {completed ? (
          <button type="button" className={styles.primary} onClick={onContinue}>
            {isLast ? 'See summary' : 'Continue'}
          </button>
        ) : (
          <>
            <button
              type="button"
              className={styles.primary}
              disabled={actions.busy}
              onClick={() => void submit()}
            >
              {primary}
            </button>
            {step.hints.length > 0 && (
              <button
                type="button"
                className={styles.textButton}
                aria-expanded={hintsOpen}
                onClick={() => setHintsOpen(!hintsOpen)}
              >
                {hintsOpen ? 'Hide hints' : 'Show hints'}
              </button>
            )}
            {moreHints && (
              <button
                type="button"
                className={styles.textButton}
                disabled={actions.busy}
                onClick={async () => {
                  const next = await actions.hint({ stepId: step.id });
                  if (next) setHintsOpen(true);
                }}
              >
                {step.hints.length === 0 ? 'Show a hint' : 'Show next hint'}
              </button>
            )}
            {showSolution && (
              <button
                type="button"
                className={styles.textButton}
                disabled={actions.busy}
                onClick={() => void actions.solution({ stepId: step.id })}
              >
                Show solution
              </button>
            )}
          </>
        )}
      </div>
      {problem && (
        <p className={styles.inlineError} role="alert">
          {problem}
        </p>
      )}
      {step.hints.length > 0 && (
        <p className={`${styles.small} ${styles.muted} ${styles.hintsUsed}`}>
          Hints used: {step.hints.length} of {step.hintCount}. Use is recorded for review.
        </p>
      )}
      <div role="status">
        {hintsOpen && step.hints.length > 0 && !completed && (
          <div className={styles.feedback}>
            <ol>
              {step.hints.map((h, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: hints are append-only and ordered
                <li key={i}>
                  <strong>Hint {i + 1}.</strong> {h}
                </li>
              ))}
            </ol>
          </div>
        )}
        <Outcome step={step} />
      </div>
    </div>
  );
}

/** What the server recorded for the step: the revealed solution, else feedback on the last check. */
function Outcome({ step }: { step: AttemptStep }) {
  if (step.solution !== null) {
    return (
      <div className={styles.feedback}>
        <strong>Solution</strong>
        <p>{step.solution}</p>
        <p>This step is recorded as completed with the solution shown.</p>
      </div>
    );
  }
  if (!step.feedback) return null;
  const heading =
    step.status === 'completed'
      ? SAVES_TEXT.has(step.kind)
        ? 'Saved.'
        : 'Correct.'
      : step.kind === 'simulation'
        ? 'Recorded.'
        : 'Not yet.';
  return (
    <div className={styles.feedback}>
      <strong>{heading}</strong>
      <p>{step.feedback}</p>
      {step.status === 'pending' && step.kind !== 'simulation' && (
        <p className={styles.muted}>Your answer is kept. Try once more.</p>
      )}
    </div>
  );
}

function Summary({
  attempt,
  busy,
  onRestart,
}: {
  attempt: Attempt;
  busy: boolean;
  onRestart: () => void;
}) {
  const completion = attempt.completion;
  return (
    <div>
      <div className={styles.head}>
        <h3>Exercise complete.</h3>
        <p className={styles.muted}>
          {completion ? `Completed ${HELP_LABEL[completion]}. ` : ''}
          Your answers are saved for review; practice is ungraded.
        </p>
      </div>
      <ul className={styles.summary} aria-label="How each step was completed">
        {attempt.steps.map((s) => (
          <li key={s.id}>
            <span>{s.title}</span>
            <span className={styles.muted}>{s.help ? HELP_LABEL[s.help] : 'not completed'}</span>
            {s.solution !== null && <p className={styles.solutionNote}>Solution: {s.solution}</p>}
          </li>
        ))}
      </ul>
      <div className={styles.actions}>
        <button type="button" className={styles.textButton} disabled={busy} onClick={onRestart}>
          Start again
        </button>
      </div>
    </div>
  );
}

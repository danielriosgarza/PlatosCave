import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import buttons from '../components/Buttons.module.css';
import { Loading } from '../components/Loading';
import {
  type Attempt,
  type AttemptStep,
  type ExerciseStepView,
  useAttempt,
  useAttemptActions,
  useExerciseView,
} from './attempt';
import { creditSummary } from './credit';
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
    if (isArchived(query.error)) {
      return <ExerciseReading classId={classId} resourceId={resourceId} title={title} />;
    }
    return <OpenFailure error={query.error} retry={() => void query.refetch()} />;
  }
  if (!query.data) return <Loading label="Opening exercise" />;
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

/** The class is archived and the caller has no attempt to resume: the server starts none. */
const isArchived = (error: unknown) =>
  error instanceof ApiError &&
  error.status === 409 &&
  (error.body as { error?: unknown } | null)?.error === 'class_archived';

/** Why the exercise did not open: the server's reason, a retry for a lost connection, else it is closed. */
function OpenFailure({ error, retry }: { error: unknown; retry: () => void }) {
  const body = error instanceof ApiError ? (error.body as { message?: unknown } | null) : null;
  if (error instanceof ApiError && error.status === 400 && typeof body?.message === 'string') {
    return (
      <p className={styles.inlineError} role="alert">
        {body.message}
      </p>
    );
  }
  if (error instanceof ApiError && error.status === 404) {
    return (
      <p className={styles.inlineError} role="alert">
        This exercise could not be opened. It may not be open to you yet.
      </p>
    );
  }
  return (
    <div className={styles.inlineError} role="alert">
      <p>This exercise could not be opened. Check your connection and try again.</p>
      <button type="button" className={buttons.outline} onClick={retry}>
        Try again
      </button>
    </div>
  );
}

/**
 * An exercise never started in an archived class: its steps to read, with nothing to answer,
 * check, reveal or restart. Hints and solutions are not sent (§4, §9).
 */
function ExerciseReading({
  classId,
  resourceId,
  title,
}: {
  classId: string;
  resourceId: string;
  title: string;
}) {
  const query = useExerciseView(classId, resourceId);
  if (query.isError) {
    return <OpenFailure error={query.error} retry={() => void query.refetch()} />;
  }
  if (!query.data) return <Loading label="Opening exercise" />;
  const steps = query.data.steps;
  return (
    <section className={styles.stage} aria-label={`Exercise ${title}`}>
      <div className={styles.exercise}>
        <p className={styles.notice} role="status">
          This class is archived, so practice is read-only. You did not start this exercise; its
          steps are shown for reading and nothing is recorded.
        </p>
        <ol className={styles.readSteps} aria-label={`Steps of ${title}`}>
          {steps.map((step, i) => (
            <li key={step.id}>
              <div className={styles.head}>
                <div className={styles.stepLabel}>{`${i + 1} · ${step.title}`}</div>
                <p className={styles.prompt}>{step.prompt}</p>
              </div>
              <StepContent step={step} />
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** What a step asks for, as text: its options, items, pairs, control or starter code. */
function StepContent({ step }: { step: ExerciseStepView }) {
  const list = (label: string, items: { id: string; label: string }[] | undefined) => (
    <ul className={styles.readItems} aria-label={label}>
      {(items ?? []).map((item) => (
        <li key={item.id}>{item.label}</li>
      ))}
    </ul>
  );
  switch (step.kind) {
    case 'numeric':
      return (
        <p className={`${styles.small} ${styles.centered}`}>
          {step.unit ? `A number, in ${step.unit}.` : 'A number.'}
        </p>
      );
    case 'single_choice':
      return list('Options; one is correct', step.options);
    case 'multiple_choice':
      return list('Options; any number may be correct', step.options);
    case 'ordering':
      return list('Items to put in order', step.options);
    case 'matching':
      return (
        <>
          {list('Items to match', step.prompts)}
          {list('Choices', step.choices)}
        </>
      );
    case 'simulation': {
      const control = step.control;
      if (!control) return null;
      return (
        <p className={`${styles.small} ${styles.centered}`}>
          {`${control.label} (${control.name}) from ${control.min} to ${control.max} in steps of ${control.step}`}
          {step.compare?.length
            ? `; compare ${control.name} = ${step.compare.join(' and ')}.`
            : '.'}
        </p>
      );
    }
    case 'code':
      return (
        <div className={`${styles.explain} ${styles.code}`}>
          <p className={styles.small}>{`Written in ${step.language === 'r' ? 'R' : 'Python'}.`}</p>
          {step.starter && <pre className={styles.readCode}>{step.starter}</pre>}
        </div>
      );
    case 'text':
      return <p className={`${styles.small} ${styles.centered}`}>A written explanation.</p>;
  }
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
  const [announced, setAnnounced] = useState('');
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
        <div
          className={styles.track}
          role="img"
          aria-label={
            summary
              ? 'Exercise complete'
              : `Exercise step ${index + 1} of ${steps.length}: ${step?.title}; ${done} complete`
          }
        >
          {steps.map((s, i) => (
            <span key={s.id} data-done={s.status === 'completed' || i <= index} />
          ))}
        </div>
        {notice && (
          <p className={styles.notice} role="status">
            {notice}
          </p>
        )}
        <p className={styles.visuallyHidden} role="status">
          {announced}
        </p>
        {summary ? (
          <Summary
            attempt={attempt}
            busy={actions.busy}
            focusHeading={announced !== ''}
            // The new attempt has its own id, which remounts this view at its first step.
            onRestart={() => void actions.restart()}
          />
        ) : (
          <StepPanel
            key={`${attempt.id}:${step.id}`}
            step={step}
            isLast={index === last}
            actions={actions}
            focusHeading={announced !== ''}
            onContinue={() => {
              const next = steps[index + 1];
              setAnnounced(
                next ? `Step ${index + 2} of ${steps.length}: ${next.title}` : 'Exercise complete.',
              );
              setIndex(index + 1);
            }}
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
  focusHeading,
  onContinue,
}: {
  step: AttemptStep;
  isLast: boolean;
  actions: Actions;
  /** Reached with Continue: the keyed panel is new, so focus moves to its heading. */
  focusHeading: boolean;
  onContinue: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when this step's panel mounts
  useEffect(() => {
    if (focusHeading) heading.current?.focus();
  }, []);
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
  const showSolution = step.hasSolution && !completed && step.solution === null;

  return (
    <div>
      <div className={styles.head}>
        <h3 ref={heading} tabIndex={-1}>
          {step.title}
        </h3>
        <p className={styles.prompt}>{step.prompt}</p>
      </div>
      <StepForm step={step} draft={draft} disabled={completed || actions.busy} onChange={change} />
      <div className={styles.actions}>
        {completed ? (
          <button type="button" className={buttons.primary} onClick={onContinue}>
            {isLast ? 'See summary' : 'Continue'}
          </button>
        ) : (
          <>
            <button
              type="button"
              className={buttons.primary}
              // Not `disabled`: the button holds keyboard focus while the answer is checked.
              aria-disabled={actions.busy || undefined}
              onClick={() => {
                if (!actions.busy) void submit();
              }}
            >
              {primary}
            </button>
            {step.hints.length > 0 && (
              <button
                type="button"
                className={buttons.textButton}
                aria-expanded={hintsOpen}
                onClick={() => setHintsOpen(!hintsOpen)}
              >
                {hintsOpen ? 'Hide hints' : 'Show hints'}
              </button>
            )}
            {moreHints && (
              <button
                type="button"
                className={buttons.textButton}
                aria-disabled={actions.busy || undefined}
                onClick={async () => {
                  if (actions.busy) return;
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
                className={buttons.textButton}
                aria-disabled={actions.busy || undefined}
                onClick={() => {
                  if (!actions.busy) void actions.solution({ stepId: step.id });
                }}
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
        <p>
          {step.status === 'completed'
            ? 'This step is recorded as completed with the solution shown.'
            : 'Showing the solution is recorded. This step still needs your own answer.'}
        </p>
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
  focusHeading,
  onRestart,
}: {
  attempt: Attempt;
  busy: boolean;
  focusHeading: boolean;
  onRestart: () => void;
}) {
  const completion = attempt.completion;
  const heading = useRef<HTMLHeadingElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the summary mounts
  useEffect(() => {
    if (focusHeading) heading.current?.focus();
  }, []);
  return (
    <div>
      <div className={styles.head}>
        <h3 ref={heading} tabIndex={-1}>
          Exercise complete.
        </h3>
        <p className={styles.muted}>
          {completion ? `Completed ${HELP_LABEL[completion]}. ` : ''}
          Your answers are saved for review;{' '}
          {attempt.credit ? creditSummary(attempt.credit) : 'practice is ungraded'}.
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
        <button type="button" className={buttons.textButton} disabled={busy} onClick={onRestart}>
          Start again
        </button>
      </div>
    </div>
  );
}

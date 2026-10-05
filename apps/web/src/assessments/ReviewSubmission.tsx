import { useEffect, useRef } from 'react';
import buttons from '../components/Buttons.module.css';
import { isAnswered } from './answers';
import type { AttemptView } from './api';
import { formatInZone } from './TermsPanel';
import styles from './Test.module.css';
import type { Entry } from './useAnswers';

export type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string };

interface Props {
  attempt: AttemptView;
  entries: Record<string, Entry>;
  online: boolean;
  state: SubmitState;
  onSubmit: () => void;
  onKeepWorking: () => void;
  onGoTo: (index: number) => void;
}

/**
 * Review submission (§11): the unanswered questions, any unsaved changes and the effective
 * deadline, before Submit test. Submitting needs the server, so it is off while offline (§14).
 */
export function ReviewSubmission({
  attempt,
  entries,
  online,
  state,
  onSubmit,
  onKeepWorking,
  onGoTo,
}: Props) {
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => heading.current?.focus(), []);
  const { questions, terms } = attempt;
  const unanswered = questions
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => !isAnswered(entries[q.id]?.value));
  const flagged = questions.map((q, i) => ({ q, i })).filter(({ q }) => entries[q.id]?.flagged);
  const unsaved = questions
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => entries[q.id] && entries[q.id]?.status !== 'saved');
  const busy = state.kind === 'submitting';
  return (
    <div className={styles.stack}>
      <h3 ref={heading} tabIndex={-1}>
        Review submission
      </h3>
      <p>
        {unanswered.length === 0
          ? `All ${questions.length} questions have an answer.`
          : `${unanswered.length} of ${questions.length} questions have no answer:`}
      </p>
      {unanswered.length > 0 ? (
        <ul className={styles.list} aria-label="Unanswered questions">
          {unanswered.map(({ i }) => (
            <li key={i}>
              <button type="button" className={buttons.textButton} onClick={() => onGoTo(i)}>
                Question {i + 1}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {flagged.length > 0 ? (
        <p>Flagged for review: {flagged.map(({ i }) => `Question ${i + 1}`).join(', ')}.</p>
      ) : null}
      {unsaved.length > 0 ? (
        <p>
          <strong>Not saved yet:</strong> {unsaved.map(({ i }) => `Question ${i + 1}`).join(', ')}.
          Submitting saves these first; if that fails, nothing is submitted.
        </p>
      ) : null}
      <p>
        {attempt.deadlineAt
          ? `Closes ${formatInZone(attempt.deadlineAt, terms.timeZone)}.`
          : 'This attempt has no deadline.'}{' '}
        You cannot change answers after you submit.
      </p>
      {!online ? (
        <p role="status">
          Submitting is unavailable while you are offline. Your answers stay here.
        </p>
      ) : null}
      {state.kind === 'error' ? (
        <p className={styles.error} role="alert">
          {state.message}
        </p>
      ) : null}
      <div className={styles.row}>
        <button
          type="button"
          className={buttons.primary}
          onClick={onSubmit}
          disabled={busy || !online}
        >
          {busy ? 'Submitting…' : state.kind === 'error' ? 'Retry submit' : 'Submit test'}
        </button>
        <button
          type="button"
          className={buttons.textButton}
          onClick={onKeepWorking}
          disabled={busy}
        >
          Keep working
        </button>
      </div>
    </div>
  );
}

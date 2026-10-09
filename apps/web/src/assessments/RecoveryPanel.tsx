import { reviewTestAttempts } from '@parallax/contracts/routes/tests';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';
import { ApiError } from '../api/client';
import buttons from '../components/Buttons.module.css';
import { Loading } from '../components/Loading';
import { RetryNotice } from '../components/RetryNotice';
import { formatInstant } from '../format/format';
import { recoveryAnswered } from './answers';
import { askForRecovery, useReviewedAttempt, useReviewedAttempts } from './api';
import styles from './Test.module.css';

const isStudentRemoved = (error: ApiError) =>
  (error.body as { error?: string } | null)?.error === 'student_removed';

type Reviewed = z.output<typeof reviewTestAttempts.response>['attempts'][number];

/**
 * Closed attempts of one test with the state of their unsent local work (§11, A15): an instructor
 * asks a student for it, with a reason, and reads what the student sent. What was sent is never
 * part of the submission and is labelled so.
 */
export function RecoveryPanel({ classId, resourceId }: { classId: string; resourceId: string }) {
  const queryClient = useQueryClient();
  const list = useReviewedAttempts(classId, resourceId);
  if (list.isError) {
    return (
      <RetryNotice message="Attempts could not be loaded." onRetry={() => void list.refetch()} />
    );
  }
  if (!list.data) return <Loading label="Loading attempts" className={styles.small} />;
  const closed = list.data.attempts.filter((a) => a.state !== 'in_progress');
  if (closed.length === 0) return <p className={styles.small}>No attempt has closed yet.</p>;
  return (
    <>
      <p>
        <button
          type="button"
          className={buttons.textButton}
          onClick={() => {
            void queryClient.invalidateQueries({ queryKey: ['review-attempt', classId] });
            void list.refetch();
          }}
          disabled={list.isFetching}
        >
          {list.isFetching ? 'Checking…' : 'Check for sent work'}
        </button>
      </p>
      <ul className={styles.attempts} aria-label="Closed attempts and unsent work">
        {closed.map((a) => (
          <RecoveryRow key={a.id} classId={classId} attempt={a} />
        ))}
      </ul>
    </>
  );
}

function RecoveryRow({ classId, attempt }: { classId: string; attempt: Reviewed }) {
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState(false);
  const detail = useReviewedAttempt(classId, attempt.id, viewing);
  const requested = attempt.recoveryRequestedAt;
  const received = attempt.localCopyAt;
  const answered = recoveryAnswered(requested, received);
  const when = (iso: string) => formatInstant(iso, attempt.timeZone);

  async function ask() {
    if (busy || reason.trim() === '') return;
    setBusy(true);
    setProblem(null);
    try {
      await askForRecovery(classId, attempt.id, reason.trim());
      setAsking(false);
      setReason('');
      await queryClient.invalidateQueries({
        queryKey: [reviewTestAttempts.method, reviewTestAttempts.path],
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && isStudentRemoved(error)) {
        // The page was loaded before the student left; reload the list so the row says so.
        setAsking(false);
        setReason('');
        await queryClient.invalidateQueries({
          queryKey: [reviewTestAttempts.method, reviewTestAttempts.path],
        });
      } else {
        setProblem('The request was not recorded. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  const names = new Map(
    ((detail.data?.test.questions as { id: string; prompt?: string }[] | undefined) ?? []).map(
      (q, i) => [q.id, `Question ${i + 1}`] as const,
    ),
  );
  return (
    <li className={styles.block}>
      <strong>
        {attempt.student.name} · attempt {attempt.number}
      </strong>
      <br />
      <span className={`${styles.small} ${styles.muted}`}>
        {received
          ? `Unsent work kept ${when(received)}; not part of the submission`
          : 'No unsent work kept by the server'}
        {requested
          ? ` · asked for ${when(requested)}${answered ? ', received' : attempt.removed ? ', not answered' : ', waiting'}`
          : ''}
        {attempt.removed && !answered ? ' · has left the class and cannot answer' : ''}
      </span>
      <div className={styles.row}>
        {received ? (
          <button type="button" className={buttons.outline} onClick={() => setViewing((v) => !v)}>
            {viewing ? 'Hide unsent work' : 'View unsent work'}
          </button>
        ) : null}
        {!asking && !answered && !attempt.removed ? (
          <button type="button" className={buttons.outline} onClick={() => setAsking(true)}>
            {requested ? 'Ask again' : 'Ask for unsent work'}
          </button>
        ) : null}
      </div>
      {asking ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void ask();
          }}
        >
          <label>
            Reason, shown in the audit history
            <input
              type="text"
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              required
            />
          </label>
          <p className={styles.row}>
            <button type="submit" className={buttons.primary} disabled={busy}>
              Send request
            </button>
            <button type="button" className={buttons.outline} onClick={() => setAsking(false)}>
              Cancel
            </button>
          </p>
          {problem ? (
            <p className={styles.error} role="alert">
              {problem}
            </p>
          ) : null}
        </form>
      ) : null}
      {viewing && detail.isError ? (
        <RetryNotice
          message="Unsent work could not be loaded."
          onRetry={() => void detail.refetch()}
        />
      ) : null}
      {viewing && detail.data ? (
        <div className={styles.notice}>
          <p>
            <strong>Not part of the submission.</strong> Sent by the student's browser after the
            attempt closed.
          </p>
          {(detail.data.localCopy ?? []).map((a) => (
            <div key={a.questionId}>
              <p>
                <strong>{names.get(a.questionId) ?? a.questionId}</strong>
              </p>
              <pre>{typeof a.value === 'string' ? a.value : JSON.stringify(a.value, null, 2)}</pre>
            </div>
          ))}
        </div>
      ) : null}
    </li>
  );
}

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import buttons from '../components/Buttons.module.css';
import { OfflineBanner, useOnline } from '../components/OfflineBanner';
import { AnswerInput } from './AnswerInput';
import { isAnswered, navLabel } from './answers';
import {
  type AttemptView,
  attemptKey,
  closedReceipt,
  fetchAttempt,
  type Question,
  sendLocalCopy,
  submitAttempt,
} from './api';
import { ReceiptView } from './Receipt';
import { ReviewSubmission, type SubmitState } from './ReviewSubmission';
import { TermsPanel } from './TermsPanel';
import styles from './Test.module.css';
import { clearUnsent, type Entry, useAnswers } from './useAnswers';

const keyStore = (attemptId: string) => `pc-test-submit-key:${attemptId}`;

/** One key per attempt: a repeated click, a retry and a reload all send the same one (A14). */
function submissionKey(attemptId: string): string {
  try {
    const kept = window.sessionStorage.getItem(keyStore(attemptId));
    if (kept) return kept;
  } catch {
    // Storage may be blocked; the key then lives for this page only.
  }
  const fresh =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `key-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    window.sessionStorage.setItem(keyStore(attemptId), fresh);
  } catch {
    // see above
  }
  return fresh;
}

const KIND_LABEL: Record<Question['kind'], string> = {
  choice: 'Multiple choice',
  numeric: 'Numeric answer',
  explanation: 'Explanation',
  code: 'Code implementation',
};

const pointsText = (points: number) => `${points} ${points === 1 ? 'point' : 'points'}`;

function saveText(entry: Entry | undefined): string {
  if (!entry) return '';
  if (entry.status === 'saving') return 'Saving…';
  if (entry.status === 'dirty') return 'Unsaved changes';
  if (entry.status === 'failed') return entry.error ?? 'Not saved';
  if (entry.savedAt) {
    return `Saved ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(entry.savedAt))}`;
  }
  return 'Nothing to save yet';
}

/**
 * How far the browser's clock is from the server's, fixed when the attempt was read: the server
 * says what time it was, and the browser notes its own clock at that moment.
 */
function useServerSkew(attempt: AttemptView): number {
  return useMemo(() => Date.parse(attempt.serverNow) - Date.now(), [attempt.serverNow]);
}

/** Minutes left on the server's clock, as of the last read; the server alone decides lateness. */
function useMinutesLeft(attempt: AttemptView, skew: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!attempt.deadlineAt) return null;
  const left = Date.parse(attempt.deadlineAt) - (now + skew);
  return Math.max(0, Math.ceil(left / 60_000));
}

function minutesText(minutes: number): string {
  if (minutes <= 0) return 'Time is up; the server is closing your attempt';
  return `About ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left`;
}

/** The recovery file for answers that never reached the server (§14). */
function unsentText(attempt: AttemptView, entries: Record<string, Entry>) {
  return attempt.questions
    .filter((q) => entries[q.id] && entries[q.id]?.status !== 'saved')
    .map((q) => {
      const value = entries[q.id]?.value;
      const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      return `Question ${attempt.questions.indexOf(q) + 1}\n${text}\n`;
    })
    .join('\n');
}

function saveFile(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * One attempt of a test (§11): the question and its answer area, navigation with
 * Answered / Unanswered / Flagged, terms in the prompt column, autosave with acknowledgement,
 * Review submission and the receipt. The server's state wins whenever it differs from the page.
 */
export function AttemptWorkspace({
  classId,
  title,
  initial,
  onLeave,
}: {
  classId: string;
  title: string;
  initial: AttemptView;
  onLeave: () => void;
}) {
  const queryClient = useQueryClient();
  const key = useMemo(() => attemptKey(classId, initial.id), [classId, initial.id]);
  const query = useQuery({
    queryKey: key,
    queryFn: () => fetchAttempt(classId, initial.id),
    initialData: initial,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const attempt = query.data;
  const [current, setCurrent] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const [submit, setSubmit] = useState<SubmitState>({ kind: 'idle' });
  const [local, setLocal] = useState<'none' | 'sending' | 'kept' | 'failed'>('none');
  const [unsentCount, setUnsentCount] = useState(0);
  const online = useOnline();
  const submitting = useRef(false);
  const refreshing = useRef(false);

  // `useAnswers` needs a closing handler before the server state it triggers is known.
  const closing = useRef<() => void>(() => {});
  const onClosed = useCallback(() => closing.current(), []);
  const answers = useAnswers(classId, initial, onClosed);
  const { entries, flush, adopt, stop } = answers;
  const open = attempt.state === 'in_progress';

  /** Reads the server's state; an attempt past its deadline is settled by that very read. */
  const refresh = useCallback(async (): Promise<AttemptView | null> => {
    if (refreshing.current) return null;
    refreshing.current = true;
    try {
      const view = await fetchAttempt(classId, initial.id);
      queryClient.setQueryData(key, view);
      return view;
    } catch {
      return null;
    } finally {
      refreshing.current = false;
    }
  }, [classId, initial.id, queryClient, key]);

  const keepLocal = useCallback(
    async (view: AttemptView) => {
      const unsent = view.questions
        .filter((q) => entries[q.id] && entries[q.id]?.status !== 'saved')
        .map((q) => ({ questionId: q.id, value: entries[q.id]?.value ?? null }));
      setUnsentCount(unsent.length);
      if (unsent.length === 0 || view.localCopyAt) return;
      setLocal('sending');
      try {
        await sendLocalCopy(classId, view.id, unsent);
        setLocal('kept');
        clearUnsent(view.id);
        void refresh();
      } catch {
        setLocal('failed');
      }
    },
    [classId, entries, refresh],
  );

  // The attempt closed under the page (a deadline, or a save the server refused): read the
  // server's state, then keep anything it never received (§11).
  closing.current = () => {
    stop();
    void refresh().then((view) => {
      if (view && view.state !== 'in_progress') void keepLocal(view);
    });
  };

  // Reconnect or return to the tab: the server's state first, then the unsent work (§11).
  const resume = () => {
    void refresh().then((view) => {
      if (!view) return;
      if (view.state !== 'in_progress') {
        stop();
        void keepLocal(view);
      } else {
        adopt(view);
        void flush();
      }
    });
  };
  // The listeners stay put across renders: a re-render during the `online` event itself (the
  // offline banner reacts to it) would otherwise swap them out before they were called.
  const resumeNow = useRef(resume);
  resumeNow.current = resume;
  useEffect(() => {
    if (!open) return;
    const onOnline = () => resumeNow.current();
    const onVisible = () => document.visibilityState === 'visible' && resumeNow.current();
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [open]);

  // At the deadline the server closes the attempt; asking it is what settles the page.
  const deadlineMs = attempt.deadlineAt ? Date.parse(attempt.deadlineAt) : null;
  const skew = useServerSkew(attempt);
  useEffect(() => {
    if (!open || deadlineMs === null) return;
    const wait = Math.max(0, deadlineMs - (Date.now() + skew)) + 1500;
    const timer = window.setTimeout(() => closing.current(), Math.min(wait, 2 ** 31 - 1));
    return () => window.clearTimeout(timer);
  }, [open, deadlineMs, skew]);

  const minutes = useMinutesLeft(attempt, skew);

  async function doSubmit() {
    if (submitting.current) return;
    submitting.current = true;
    setSubmit({ kind: 'submitting' });
    try {
      const unsaved = await flush();
      if (unsaved.length > 0) {
        const names = unsaved
          .map((id) => `Question ${attempt.questions.findIndex((q) => q.id === id) + 1}`)
          .join(', ');
        setSubmit({
          kind: 'error',
          message: `${names} could not be saved, so nothing was submitted. Retry.`,
        });
        return;
      }
      const receipt = await submitAttempt(classId, attempt.id, submissionKey(attempt.id));
      stop();
      clearUnsent(attempt.id);
      queryClient.setQueryData(key, {
        ...attempt,
        state: 'submitted',
        submittedAt: receipt.submittedAt,
        receipt,
      } satisfies AttemptView);
      setSubmit({ kind: 'idle' });
    } catch (error) {
      const shut = closedReceipt(error);
      if (shut) {
        stop();
        const view = await refresh();
        if (view && view.state !== 'in_progress') void keepLocal(view);
        setSubmit({ kind: 'idle' });
      } else {
        setSubmit({
          kind: 'error',
          message:
            'The server did not acknowledge the submission, so nothing is shown as submitted. Retrying sends the same submission key and cannot submit twice.',
        });
      }
    } finally {
      submitting.current = false;
    }
  }

  if (!open) {
    return (
      <div className={styles.stage}>
        <ReceiptView
          attempt={attempt}
          unsentCount={unsentCount}
          local={local}
          onRetryLocal={() => void keepLocal(attempt)}
          onDownload={() => saveFile('unsent-answers.txt', unsentText(attempt, entries))}
        />
        <p className={styles.receipt}>
          <button type="button" className={buttons.outline} onClick={onLeave}>
            Back to the test
          </button>
        </p>
      </div>
    );
  }

  const question = attempt.questions[current] as Question;
  const entry = entries[question.id];
  const counts = attempt.questions.reduce(
    (n, q) => {
      const e = entries[q.id];
      if (isAnswered(e?.value)) n.answered += 1;
      if (e?.flagged) n.flagged += 1;
      return n;
    },
    { answered: 0, flagged: 0 },
  );
  const total = attempt.questions.length;
  return (
    <div className={styles.stage}>
      <OfflineBanner>
        You are offline. Changes are kept in this browser and are not saved to the server. Running
        and submitting are unavailable until you are online.
      </OfflineBanner>
      <h2 className={styles.title}>{title}</h2>
      <div className={styles.top}>
        <div className={styles.row}>
          <span className={styles.context}>
            Question {current + 1} / {total}
          </span>
          <span className={`${styles.small} ${styles.muted}`}>
            {counts.answered} answered · {total - counts.answered} unanswered · {counts.flagged}{' '}
            flagged
          </span>
        </div>
        {minutes !== null ? (
          <span className={`${styles.small} ${styles.muted}`}>{minutesText(minutes)}</span>
        ) : null}
      </div>
      <nav className={styles.nav} aria-label="Questions">
        <ol>
          {attempt.questions.map((q, i) => (
            <li key={q.id}>
              <button
                type="button"
                className={styles.navItem}
                aria-current={i === current ? 'step' : undefined}
                onClick={() => {
                  setCurrent(i);
                  setReviewing(false);
                }}
              >
                Question {i + 1}{' '}
                <span className={styles.navState}>
                  {navLabel(isAnswered(entries[q.id]?.value), Boolean(entries[q.id]?.flagged))}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <div className={styles.grid}>
        <article className={styles.prompt}>
          <h3>Question {current + 1}</h3>
          <div className={styles.context}>
            {KIND_LABEL[question.kind]} / {pointsText(question.points)}
          </div>
          <p>{question.prompt}</p>
          {question.kind === 'code' ? (
            <div className={`${styles.small} ${styles.muted}`}>
              {question.runtime.startsWith('r-') ? 'R' : 'Python'}{' '}
              {question.runtime.slice(question.runtime.indexOf('-') + 1)}
              {question.allowedPackages.length > 0
                ? ` · packages: ${question.allowedPackages.join(', ')}`
                : ' · standard library only'}{' '}
              · {question.limits.wallSeconds} s · {question.limits.memoryMiB} MiB
              <br />
              Sample tests are shown. Grading may also use tests that are not shown.
            </div>
          ) : null}
          <div className={styles.rule} />
          <TermsPanel
            terms={attempt.terms}
            attemptNumber={attempt.number}
            deadlineAt={attempt.deadlineAt}
          />
        </article>
        <div>
          <AnswerInput
            key={question.id}
            question={question}
            classId={classId}
            attemptId={attempt.id}
            value={entry?.value ?? null}
            onChange={(value) => answers.edit(question.id, { value })}
            flush={flush}
            onClosed={onClosed}
          />
          <div className={`${styles.row} ${styles.between}`} style={{ marginTop: 16 }}>
            <label className={styles.row}>
              <input
                type="checkbox"
                checked={Boolean(entry?.flagged)}
                onChange={(e) => answers.edit(question.id, { flagged: e.target.checked })}
              />
              Flag for review
            </label>
            <span className={styles.statusLine} role="status" aria-live="polite">
              {saveText(entry)}
              {entry?.status === 'failed' ? (
                <>
                  {' '}
                  <button
                    type="button"
                    className={buttons.textButton}
                    onClick={() => void answers.send(question.id)}
                  >
                    Retry save
                  </button>
                </>
              ) : null}
            </span>
          </div>
          <div className={styles.row} style={{ marginTop: 12 }}>
            <button
              type="button"
              className={buttons.outline}
              disabled={current === 0}
              onClick={() => setCurrent(current - 1)}
            >
              Previous question
            </button>
            <button
              type="button"
              className={buttons.outline}
              disabled={current === total - 1}
              onClick={() => setCurrent(current + 1)}
            >
              Next question
            </button>
          </div>
        </div>
      </div>
      <div className={styles.review}>
        {reviewing ? (
          <ReviewSubmission
            attempt={attempt}
            entries={entries}
            online={online}
            state={submit}
            onSubmit={() => void doSubmit()}
            onKeepWorking={() => {
              setReviewing(false);
              setSubmit({ kind: 'idle' });
            }}
            onGoTo={(i) => {
              setCurrent(i);
              setReviewing(false);
            }}
          />
        ) : (
          <div className={`${styles.row} ${styles.between}`}>
            <span className={`${styles.small} ${styles.muted}`}>
              Answers stay editable until you submit.
            </span>
            <button type="button" className={buttons.primary} onClick={() => setReviewing(true)}>
              Review submission
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import buttons from '../components/Buttons.module.css';
import { useOnline } from '../components/OfflineBanner';
import { type CodeFile, hashFiles } from './answers';
import {
  asStudentRun,
  type CodeQuestionView,
  cancelQueuedRun,
  closedReceipt,
  fetchLatestRun,
  fetchRun,
  type StudentRunView,
  startRun,
} from './api';
import { RunResult } from './RunOutput';
import styles from './Test.module.css';

const POLL_MS = 1500;
const settled = (run: StudentRunView) => run.state !== 'queued' && run.state !== 'running';

interface Props {
  classId: string;
  attemptId: string;
  question: CodeQuestionView;
  files: CodeFile[];
  /** Saves everything unsent; resolves with the questions still unsaved (a run needs a saved snapshot). */
  flush: () => Promise<string[]>;
  onClosed: () => void;
}

/**
 * Run sample tests (§11). The output belongs to the snapshot it ran on, named by its hash; the
 * moment the code differs from it the output is labelled out of date. A run that could not reach
 * the runner says so and consumes nothing.
 */
export function RunPanel({ classId, attemptId, question, files, flush, onClosed }: Props) {
  const online = useOnline();
  const [run, setRun] = useState<StudentRunView | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const runId = run?.runId;
  const live = run !== null && !settled(run);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The latest run is restored after a reload or when the student returns to the question.
  useEffect(() => {
    let cancelled = false;
    fetchLatestRun(classId, attemptId, question.id)
      .then((body) => {
        if (!cancelled && body.run) setRun((current) => current ?? asStudentRun(body.run));
      })
      .catch(() => {
        // Nothing to restore; a failed read must not look like a failed run.
      });
    return () => {
      cancelled = true;
    };
  }, [classId, attemptId, question.id]);

  // A queued or running run is read again until the server settles it. Each answer is a new
  // object, so the effect runs again and schedules the next read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `run` re-arms the timer after each read
  useEffect(() => {
    if (!live || !runId) return;
    const timer = window.setTimeout(() => {
      fetchRun(classId, attemptId, runId)
        .then((next) => {
          if (mounted.current) setRun(asStudentRun(next));
        })
        .catch(() => {
          // The next tick tries again; the last known state stays on screen.
        });
    }, POLL_MS);
    return () => window.clearTimeout(timer);
  }, [live, runId, run, classId, attemptId]);

  // The hash of the code on screen, to compare with the snapshot the output belongs to.
  const signature = JSON.stringify(files);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` stands for `files`
  useEffect(() => {
    let cancelled = false;
    hashFiles(files)
      .then((h) => {
        if (!cancelled) setHash(h);
      })
      .catch(() => setHash(null));
    return () => {
      cancelled = true;
    };
  }, [signature]);

  async function runNow() {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const unsaved = await flush();
      if (unsaved.includes(question.id)) {
        setProblem('Your code could not be saved, so the sample tests were not run. Retry.');
        return;
      }
      const started = await startRun(classId, attemptId, question.id, files);
      if (mounted.current) setRun(asStudentRun(started));
    } catch (error) {
      if (closedReceipt(error)) {
        onClosed();
      } else if (error instanceof ApiError && error.status === 429) {
        const body = error.body as { message?: string } | null;
        setProblem(body?.message ?? 'Two runs are already active. Wait for one to finish.');
      } else if (error instanceof ApiError && error.status === 400) {
        setProblem('These files cannot be run. Check them and try again.');
      } else {
        setProblem('Run unavailable. Your code is kept. No attempt was used.');
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function cancel() {
    if (!run) return;
    try {
      setRun(asStudentRun(await cancelQueuedRun(classId, attemptId, run.runId)));
    } catch {
      // A run that has started cannot be cancelled and finishes within its limits.
      setProblem('The run has already started and will finish on its own.');
    }
  }

  const stale = run !== null && settled(run) && hash !== null && run.codeHash !== hash;
  const snapshot = run ? run.codeHash.slice(0, 8) : '';
  const limits = question.limits;
  return (
    <section className={styles.run} aria-label="Sample tests">
      <div className={`${styles.row} ${styles.between}`}>
        <button
          type="button"
          className={buttons.outline}
          onClick={() => void runNow()}
          disabled={busy || live || !online}
        >
          {busy ? 'Running…' : 'Run sample tests'}
        </button>
        <span className={`${styles.small} ${styles.muted}`}>
          {online
            ? `${limits.wallSeconds} s · ${limits.memoryMiB} MiB · does not submit the test`
            : 'Running is unavailable while you are offline'}
        </span>
      </div>
      {problem ? (
        <p className={styles.error} role="alert">
          {problem}{' '}
          {problem.startsWith('Run unavailable') || problem.startsWith('Your code could not') ? (
            <button type="button" className={buttons.textButton} onClick={() => void runNow()}>
              Retry
            </button>
          ) : null}
        </p>
      ) : null}
      {run ? (
        <div className={styles.output} role="status" aria-live="polite" aria-label="Sample run">
          <RunState
            run={run}
            snapshot={snapshot}
            stale={stale}
            onRetry={() => void runNow()}
            onCancel={() => void cancel()}
            online={online}
          />
        </div>
      ) : null}
    </section>
  );
}

function RunState({
  run,
  snapshot,
  stale,
  onRetry,
  onCancel,
  online,
}: {
  run: StudentRunView;
  snapshot: string;
  stale: boolean;
  onRetry: () => void;
  onCancel: () => void;
  online: boolean;
}) {
  if (run.state === 'queued') {
    return (
      <>
        <p>
          <strong>Queued</strong>
          {run.queuePosition !== undefined
            ? ` · ${run.queuePosition} ${run.queuePosition === 1 ? 'run' : 'runs'} ahead of yours`
            : ''}
        </p>
        <p className={styles.small}>Snapshot {snapshot}</p>
        <button type="button" className={buttons.textButton} onClick={onCancel}>
          Cancel run
        </button>
      </>
    );
  }
  if (run.state === 'running') {
    return (
      <>
        <p>
          <strong>Running</strong>
        </p>
        <p className={styles.small}>Snapshot {snapshot}</p>
      </>
    );
  }
  if (run.state === 'cancelled') {
    return <p>Run cancelled · snapshot {snapshot}</p>;
  }
  if (run.state === 'infrastructure_error') {
    return (
      <>
        <p>
          <strong>Run unavailable</strong> · the test service did not finish this run. Your code is
          kept and no attempt was used.
        </p>
        <button type="button" className={buttons.outline} onClick={onRetry} disabled={!online}>
          Retry
        </button>
      </>
    );
  }
  return (
    <>
      <p className={`${styles.small} ${stale ? styles.stale : styles.muted}`}>
        {stale
          ? `Output is out of date · the code has changed since snapshot ${snapshot}`
          : `Output for snapshot ${snapshot} · the code as last run`}
      </p>
      <RunResult run={run} />
    </>
  );
}

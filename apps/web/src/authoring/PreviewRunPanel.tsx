import { RunnerOutcome } from '@parallax/contracts';
import {
  type instructorRun,
  readPreviewRun,
  requestPreviewRun,
} from '@parallax/contracts/routes/runs';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';
import { ApiError, call } from '../api/client';
import buttons from '../components/Buttons.module.css';
import styles from '../components/Page.module.css';
import local from './Authoring.module.css';
import { authoringKey } from './queries';
import { Area } from './TestFields';
import type { DraftQuestion } from './testForm';

type Run = z.output<typeof instructorRun>;

const STATE_TEXT: Record<Run['state'], string> = {
  queued: 'Waiting for a runner',
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  time_limited: 'Stopped at the time limit',
  resource_exhausted: 'Stopped at a resource limit',
  cancelled: 'Cancelled',
  infrastructure_error: 'Run unavailable',
};

const isSettled = (run: Run) => run.state !== 'queued' && run.state !== 'running';

const problemOf = (err: unknown): string => {
  if (err instanceof ApiError && err.status === 409) {
    const body = err.body as { error?: string } | null;
    return body?.error === 'class_archived'
      ? 'The class this preview run used was archived. Run it again.'
      : 'Teach a class of this course to preview runs.';
  }
  if (err instanceof ApiError && err.status === 400) {
    const body = err.body as { message?: string } | null;
    return body?.message ?? 'The server could not run this question.';
  }
  return 'The run could not be started.';
};

/**
 * Preview runs of the saved version of a code question (§12): the sample checks, or every check
 * with the hidden ones, in the instructor preview context. The files below are a reference
 * solution to run; they are not saved with the test.
 */
export function PreviewRunPanel({
  courseId,
  resourceId,
  question,
  saved,
}: {
  courseId: string;
  resourceId: string;
  question: DraftQuestion;
  /** True while the form matches the saved revision, which is what runs. */
  saved: boolean;
}) {
  const editable = question.files.filter((f) => f.editable && !f.hidden);
  const [solution, setSolution] = useState<Record<string, string>>({});
  const [runId, setRunId] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: (set: 'public' | 'full') =>
      call(requestPreviewRun, {
        params: { courseId, resourceId, questionId: question.id },
        body: {
          set,
          files: editable.map((f) => ({ path: f.path, content: solution[f.path] ?? f.content })),
        },
      }),
    // A failed start clears the earlier result, so it is not read as this run's.
    onMutate: () => setRunId(null),
    onSuccess: (run) => setRunId(run.runId),
  });
  const run = useQuery({
    queryKey: [...authoringKey(courseId), 'preview-run', runId],
    queryFn: () => call(readPreviewRun, { params: { courseId, runId: runId ?? '' } }),
    enabled: runId !== null,
    // A settled run or a failed read ends polling; the panel then shows what it has.
    refetchInterval: (query) =>
      query.state.status === 'error' || (query.state.data && isSettled(query.state.data))
        ? false
        : 1500,
  });
  const shown = run.data;
  const outcome = shown?.result ? RunnerOutcome.safeParse(shown.result.outcome) : undefined;
  const checks = outcome?.success ? (outcome.data.result?.checks ?? []) : [];
  const compileError = outcome?.success ? outcome.data.result?.compileError : undefined;
  const visibility = (name: string) => question.checks.find((c) => c.name === name)?.visibility;

  return (
    <section className={local.block} aria-label={`Preview runs of ${question.id}`}>
      <h4 className={styles.subheadingSmall}>Preview run</h4>
      <p className={local.hint}>
        Runs the saved version of this question. The reference solution below is run in place of the
        starter code and is not saved.
      </p>
      {editable.map((f) => (
        <Area
          key={f.path}
          label={`Reference solution: ${f.path}`}
          mono
          rows={6}
          value={solution[f.path] ?? f.content}
          onChange={(v) => setSolution({ ...solution, [f.path]: v })}
        />
      ))}
      <div className={`${styles.row} ${styles.mt12}`}>
        <button
          type="button"
          className={buttons.outline}
          disabled={!saved || start.isPending}
          onClick={() => start.mutate('public')}
        >
          Run sample checks
        </button>
        <button
          type="button"
          className={buttons.outline}
          disabled={!saved || start.isPending}
          onClick={() => start.mutate('full')}
        >
          Run all checks, hidden included
        </button>
      </div>
      {!saved ? (
        <p className={local.hint}>Preview runs are available once the draft is saved.</p>
      ) : null}
      {start.isError ? (
        <p role="alert" className={styles.small}>
          {problemOf(start.error)}
        </p>
      ) : null}
      {run.isError ? (
        <p role="alert" className={styles.small}>
          The run’s result could not be read.
        </p>
      ) : null}
      {shown ? (
        <div role="status" aria-label="Preview run result">
          <p className={styles.mt12}>
            {STATE_TEXT[shown.state]}
            {shown.checkSet === 'full' ? ' · all checks' : ' · sample checks'}
            {shown.queuePosition !== undefined ? ` · ${shown.queuePosition} ahead` : ''}
          </p>
          {shown.failure ? <p className={styles.small}>{shown.failure.message}</p> : null}
          {compileError ? (
            <pre className={local.monoOutput}>
              {`${compileError.file}${compileError.line ? `:${compileError.line}` : ''}\n${compileError.message}`}
            </pre>
          ) : null}
          <ul className={local.output}>
            {checks.map((c) => (
              <li key={c.name}>
                <strong>{c.name}</strong>
                <span className={local.badge}>
                  {visibility(c.name) === 'hidden' ? 'Hidden' : 'Sample'}
                </span>{' '}
                {c.status === 'passed'
                  ? 'passed'
                  : c.status === 'failed'
                    ? 'failed'
                    : c.status === 'timeout'
                      ? 'timed out'
                      : c.status === 'skipped'
                        ? 'skipped'
                        : `error (${c.errorKind})`}
                {c.status === 'failed' && (c.expected !== undefined || c.actual !== undefined) ? (
                  <pre>{`Expected: ${c.expected ?? '(not shown)'}\nActual: ${c.actual ?? '(not shown)'}`}</pre>
                ) : null}
                {c.message ? <pre>{c.message}</pre> : null}
                {c.stdout ? <pre>{c.stdout}</pre> : null}
                {c.stderr ? <pre>{c.stderr}</pre> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

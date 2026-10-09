import { useRef, useState } from 'react';
import { ApiError } from '../api/client';
import buttons from '../components/Buttons.module.css';
import page from '../components/Page.module.css';
import { formatInstant, points } from '../format/format';
import styles from './Grading.module.css';
import { previewRelease, type ReleasePreview, release, useRefreshGrades } from './grading';
import { useReleasePreviewFocus } from './useReleasePreviewFocus';

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'preview'; preview: ReleasePreview; note?: string }
  | { kind: 'sending'; preview: ReleasePreview }
  | { kind: 'done'; count: number; at: string }
  | { kind: 'error'; message: string };

const SKIPPED: Record<ReleasePreview['skipped'][number]['reason'], string> = {
  not_found: 'not found',
  no_grade: 'no grade to release',
  already_released: 'already released',
  incomplete: 'some questions have no points',
};

function previewTitle(view: ReleasePreview, testTitle: string): string {
  return view.recipients.length === 0
    ? 'Nothing to release'
    : `Release ${testTitle} to ${view.recipients.length} ${view.recipients.length === 1 ? 'student' : 'students'}`;
}

/**
 * Bulk release (§12): previews the exact students and results, and releases only after
 * confirmation. Names the students that would be skipped and why.
 */
export function BulkRelease({
  classId,
  attemptIds,
  names,
  testTitle,
}: {
  classId: string;
  attemptIds: string[];
  /** Display names by attempt id, for the skipped list. */
  names: Record<string, string>;
  testTitle: string;
}) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const refresh = useRefreshGrades(classId);
  const container = useRef<HTMLDivElement>(null);
  const { trigger, heading, result } = useReleasePreviewFocus<HTMLParagraphElement>(
    state.kind,
    container,
  );
  // A tick the table dropped (its grade changed) is no longer part of what a release sends.
  const current = (preview: ReleasePreview): ReleasePreview => ({
    ...preview,
    recipients: preview.recipients.filter((r) => attemptIds.includes(r.attemptId)),
  });
  const open = async () => {
    setState({ kind: 'loading' });
    try {
      setState({ kind: 'preview', preview: await previewRelease(classId, attemptIds) });
    } catch {
      setState({ kind: 'error', message: 'The release preview could not be loaded.' });
    }
  };
  const confirm = async (shown: ReleasePreview) => {
    const preview = current(shown);
    setState({ kind: 'sending', preview });
    try {
      const done = await release(
        classId,
        preview.recipients.map((r) => ({ attemptId: r.attemptId, gradeId: r.gradeId })),
      );
      setState({ kind: 'done', count: done.recipients.length, at: done.releasedAt });
      void refresh();
    } catch (error) {
      const body =
        error instanceof ApiError
          ? (error.body as { error?: string; preview?: ReleasePreview })
          : null;
      if (body?.error === 'release_changed' && body.preview) {
        setState({
          kind: 'preview',
          preview: body.preview,
          note: 'Grades changed while you were reviewing, so nothing was released. This is what a release would do now.',
        });
        // The table rows and Needs review read the same grades the preview just disagreed with.
        void refresh();
      } else {
        setState({ kind: 'error', message: 'Nothing was released. Try again.' });
      }
    }
  };
  const view = state.kind === 'preview' || state.kind === 'sending' ? current(state.preview) : null;
  return (
    <div className={styles.bulk} tabIndex={-1} ref={container}>
      <div className={page.row}>
        <button
          ref={trigger}
          type="button"
          className={buttons.outline}
          disabled={attemptIds.length === 0 || state.kind === 'loading'}
          onClick={() => void open()}
        >
          Preview release ({attemptIds.length})
        </button>
        {attemptIds.length === 0 ? (
          <span className={`${page.small} ${page.muted}`}>
            Select students with a draft grade to release feedback.
          </span>
        ) : null}
      </div>
      <p className={styles.srOnly} aria-live="polite">
        {state.kind === 'preview'
          ? `${state.note ? `${state.note} ` : ''}Release preview: ${state.preview.recipients.length} to release, ${state.preview.skipped.length} not released.`
          : ''}
      </p>
      {view && (state.kind === 'preview' || state.kind === 'sending') ? (
        <section className={styles.preview} aria-label="Release preview">
          {state.kind === 'preview' && state.note ? <p>{state.note}</p> : null}
          <h3 className={styles.previewHeading} tabIndex={-1} ref={heading}>
            {previewTitle(view, testTitle)}
          </h3>
          <ul aria-label="Recipients">
            {view.recipients.map((r) => (
              <li key={r.gradeId}>
                {r.student.name} · Attempt {r.attemptNumber} · {points(r.points)} /{' '}
                {points(r.possible)}
              </li>
            ))}
          </ul>
          {view.skipped.length > 0 ? (
            <>
              <p className={page.small}>Not released:</p>
              <ul aria-label="Skipped">
                {view.skipped.map((s) => (
                  <li key={s.attemptId}>
                    {names[s.attemptId] ?? 'An attempt'}: {SKIPPED[s.reason]}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <div className={page.row}>
            <button
              type="button"
              className={buttons.primary}
              disabled={state.kind === 'sending' || view.recipients.length === 0}
              onClick={() => void confirm(view)}
            >
              {state.kind === 'sending'
                ? 'Releasing…'
                : `Confirm release to ${view.recipients.length} ${view.recipients.length === 1 ? 'student' : 'students'}`}
            </button>
            <button
              type="button"
              className={buttons.textButton}
              disabled={state.kind === 'sending'}
              onClick={() => setState({ kind: 'idle' })}
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}
      {state.kind === 'done' ? (
        <p className={`${page.small} ${styles.success}`} role="status" tabIndex={-1} ref={result}>
          Released to {state.count} {state.count === 1 ? 'student' : 'students'} on{' '}
          {formatInstant(state.at)}.
        </p>
      ) : null}
      {state.kind === 'error' ? (
        <p className={`${page.small} ${styles.error}`} role="alert" tabIndex={-1} ref={result}>
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

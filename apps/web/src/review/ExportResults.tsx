import { exportClassResults } from '@parallax/contracts/routes/exports';
import { useEffect, useState } from 'react';
import { call } from '../api/client';
import buttons from '../components/Buttons.module.css';
import page from '../components/Page.module.css';
import { RetryNotice } from '../components/RetryNotice';

type Exported = { url: string; filename: string; rows: number; expiresAt: string };

type State =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'ready'; file: Exported }
  | { kind: 'error' };

const expiry = (at: string) =>
  new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(at));

/**
 * Results export (§12): asks the server for this class's CSV and shows the download link only
 * once the server has answered with it. The file holds the selected class and nothing else.
 */
export function ExportResults({ classId, cohort }: { classId: string; cohort: string }) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [expired, setExpired] = useState(false);
  const expiresAt = state.kind === 'ready' ? state.file.expiresAt : null;
  // The link lasts minutes: once it has lapsed the page says to export again, not offers a dead link.
  useEffect(() => {
    setExpired(false);
    if (!expiresAt) return;
    const left = new Date(expiresAt).getTime() - Date.now();
    if (left <= 0) {
      setExpired(true);
      return;
    }
    const timer = setTimeout(() => setExpired(true), left);
    return () => clearTimeout(timer);
  }, [expiresAt]);
  const start = async () => {
    setState({ kind: 'sending' });
    try {
      setState({ kind: 'ready', file: await call(exportClassResults, { params: { classId } }) });
    } catch {
      setState({ kind: 'error' });
    }
  };
  return (
    <section aria-label="Export results">
      <div className={page.row}>
        <button
          type="button"
          className={buttons.outline}
          disabled={state.kind === 'sending'}
          onClick={() => void start()}
        >
          Export results (CSV)
        </button>
        <span className={`${page.small} ${page.muted}`}>
          Test attempts of the students in {cohort}.
        </span>
      </div>
      <p className={page.small} aria-live="polite">
        {state.kind === 'sending' ? 'Preparing the export…' : null}
        {state.kind === 'ready' && expired ? 'The download link has expired. Export again.' : null}
        {state.kind === 'ready' && !expired ? (
          <>
            {state.file.rows === 1 ? '1 attempt' : `${state.file.rows} attempts`} exported.{' '}
            <a className={page.link} href={state.file.url} download={state.file.filename}>
              Download {state.file.filename}
            </a>{' '}
            (link works until {expiry(state.file.expiresAt)})
          </>
        ) : null}
      </p>
      {state.kind === 'error' ? (
        <RetryNotice
          message="The results could not be exported. Nothing was downloaded."
          onRetry={() => void start()}
        />
      ) : null}
    </section>
  );
}

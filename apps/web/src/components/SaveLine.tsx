import type { ReactNode } from 'react';
import styles from './SaveLine.module.css';

export type SaveLineStatus = 'idle' | 'saving' | 'saved' | 'offline' | 'failed';

interface SaveLineProps {
  status: SaveLineStatus;
  /** What went wrong, when the server said; replaces "Could not save" (the Retry control stays). */
  reason?: string | null;
  /** The Retry control of a failed save; without it a failure shows its text alone. */
  onRetry?: () => void;
  /**
   * Text for states outside the vocabulary (unsaved changes, a partial save, a note deleted
   * elsewhere). Shown while the status is idle or failed, in place of the failure and its Retry.
   */
  note?: ReactNode;
  /** The note is a failure: shown in the failed tone, without Retry. */
  noteFailed?: boolean;
  /** Announce a failure at once (role alert) instead of politely; for the page's main editor. */
  assertive?: boolean;
}

/**
 * The one save status of §8, beside the editing surface: Saving, Saved,
 * Offline · changes on this device, Could not save · Retry. "Saved" is shown only for the
 * `saved` status, which callers set after a real acknowledgement.
 */
export function SaveLine({ status, reason, onRetry, note, noteFailed, assertive }: SaveLineProps) {
  const showNote = note && (status === 'idle' || status === 'failed');
  let text: ReactNode = null;
  if (showNote) text = note;
  else if (status === 'saving') text = 'Saving';
  else if (status === 'saved') text = 'Saved';
  else if (status === 'offline') text = 'Offline · changes on this device';
  else if (status === 'failed') {
    text = (
      <>
        {reason ?? 'Could not save'}
        {onRetry ? (
          <>
            {' '}
            ·{' '}
            <button type="button" className={styles.retry} onClick={onRetry}>
              Retry
            </button>
          </>
        ) : null}
      </>
    );
  }
  const failed = showNote ? noteFailed : status === 'failed';
  const tone = status === 'saved' && !showNote ? styles.saved : failed ? styles.failed : '';
  // A live region whose role changes after mount can be missed: the polite status stays as it
  // is and an alert element is mounted for the failure, so assistive technology sees it appear.
  const alert = assertive && failed;
  return (
    <div className={`${styles.line} ${tone}`}>
      <span role="status">{alert ? null : text}</span>
      {alert ? <span role="alert">{text}</span> : null}
    </div>
  );
}

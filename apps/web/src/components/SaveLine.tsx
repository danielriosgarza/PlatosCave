import type { ReactNode } from 'react';
import styles from './SaveLine.module.css';

export type SaveLineStatus = 'idle' | 'saving' | 'saved' | 'offline' | 'failed';

interface SaveLineProps {
  status: SaveLineStatus;
  /** What went wrong, when the server said; replaces "Could not save" (the Retry control stays). */
  reason?: string | null;
  onRetry: () => void;
  /** Shown instead of the status, such as a choice the status cannot express. */
  override?: ReactNode;
  /** Text for states outside the vocabulary (unsaved changes, a partial save). */
  note?: ReactNode;
  /** Announce a failure at once (role alert) instead of politely; for the page's main editor. */
  assertive?: boolean;
}

/**
 * The one save status of §8, beside the editing surface: Saving, Saved,
 * Offline · changes on this device, Could not save · Retry. "Saved" is shown only for the
 * `saved` status, which callers set after a real acknowledgement.
 */
export function SaveLine({ status, reason, onRetry, override, note, assertive }: SaveLineProps) {
  let text: ReactNode = note ?? null;
  if (override) text = override;
  else if (status === 'saving') text = 'Saving';
  else if (status === 'saved') text = 'Saved';
  else if (status === 'offline') text = 'Offline · changes on this device';
  else if (status === 'failed') {
    text = (
      <>
        {reason ?? 'Could not save'} ·{' '}
        <button type="button" className={styles.retry} onClick={onRetry}>
          Retry
        </button>
      </>
    );
  }
  const tone = status === 'saved' ? styles.saved : status === 'failed' ? styles.failed : '';
  return (
    <div
      className={`${styles.line} ${tone}`}
      role={assertive && status === 'failed' ? 'alert' : 'status'}
    >
      {text}
    </div>
  );
}

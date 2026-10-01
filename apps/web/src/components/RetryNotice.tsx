import { useEffect, useMemo } from 'react';
import styles from './Page.module.css';

interface RetryNoticeProps {
  /** What failed and what is kept, in the page's own words. */
  message: string;
  onRetry: () => void;
  retryLabel?: string;
  /** A long answer or code that is still only in the browser: offered back as a file (§14). */
  recovery?: { filename: string; text: string };
}

/** Failure pattern of §14: say what failed, keep the work, offer Retry (and a download of long drafts). */
export function RetryNotice({
  message,
  onRetry,
  retryLabel = 'Try again',
  recovery,
}: RetryNoticeProps) {
  const href = useMemo(
    () =>
      recovery ? URL.createObjectURL(new Blob([recovery.text], { type: 'text/plain' })) : null,
    [recovery],
  );
  useEffect(() => () => (href ? URL.revokeObjectURL(href) : undefined), [href]);
  return (
    <div className={styles.feedback} role="alert">
      <p>{message}</p>
      <p className={styles.row}>
        <button type="button" className={styles.outline} onClick={onRetry}>
          {retryLabel}
        </button>
        {href && recovery ? (
          <a className={styles.link} href={href} download={recovery.filename}>
            Download what you wrote
          </a>
        ) : null}
      </p>
    </div>
  );
}

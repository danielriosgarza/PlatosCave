import { type ReactNode, useEffect, useState } from 'react';
import styles from './Page.module.css';

interface RetryNoticeProps {
  /** What failed and what is kept, in the page's own words. */
  message: string;
  onRetry: () => void;
  retryLabel?: string;
  /** A long answer or code that is still only in the browser: offered back as a file (§14). */
  recovery?: { filename: string; text: string };
  /** Further actions beside Retry, such as a download of the source file. */
  children?: ReactNode;
}

/** Failure pattern of §14: say what failed, keep the work, offer Retry (and a download of long drafts). */
export function RetryNotice({
  message,
  onRetry,
  retryLabel = 'Try again',
  recovery,
  children,
}: RetryNoticeProps) {
  // Created and revoked inside the effect so StrictMode's second run gets a live URL.
  const [href, setHref] = useState<string | null>(null);
  // Keyed on the content, not the object: a parent that rebuilds it each render keeps one URL.
  const text = recovery?.text;
  useEffect(() => {
    if (text === undefined) {
      setHref(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    setHref(url);
    return () => URL.revokeObjectURL(url);
  }, [text]);
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
        {children}
      </p>
    </div>
  );
}

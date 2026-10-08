import { type ReactNode, useEffect, useState } from 'react';
import buttons from './Buttons.module.css';
import styles from './Page.module.css';
import compactStyles from './RetryNotice.module.css';

interface RetryNoticeProps {
  /** What failed and what is kept, in the page's own words. */
  message: string;
  onRetry: () => void;
  retryLabel?: string;
  /** A long answer or code that is still only in the browser: offered back as a file (§14). */
  recovery?: { filename: string; text: string };
  /** Further actions beside Retry, such as a download of the source file. */
  children?: ReactNode;
  /** One line in a narrow margin, without the page-level box. */
  compact?: boolean;
}

/** Failure pattern of §14: say what failed, keep the work, offer Retry (and a download of long drafts). */
export function RetryNotice({
  message,
  onRetry,
  retryLabel = 'Try again',
  recovery,
  children,
  compact,
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
  const actions = (
    <>
      <button
        type="button"
        className={compact ? compactStyles.retry : buttons.outline}
        onClick={onRetry}
      >
        {retryLabel}
      </button>
      {href && recovery ? (
        <a className={styles.link} href={href} download={recovery.filename}>
          Download what you wrote
        </a>
      ) : null}
      {children}
    </>
  );
  // Only the message is the alert: the actions (and any status they carry, such as a failed
  // download) sit outside the live region, so they are not announced again with it.
  if (compact) {
    return (
      <div className={compactStyles.compact}>
        <span role="alert">{message}</span> {actions}
      </div>
    );
  }
  return (
    <div className={styles.feedback}>
      <p role="alert">{message}</p>
      <p className={styles.row}>{actions}</p>
    </div>
  );
}

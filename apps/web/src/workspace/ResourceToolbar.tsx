import type { RefObject } from 'react';
import styles from './ResourceToolbar.module.css';

interface ResourceToolbarProps {
  title: string;
  focus: boolean;
  fullscreen: boolean;
  notice: string | null;
  onFocus: () => void;
  onFullscreen: () => void;
  focusButton: RefObject<HTMLButtonElement | null>;
  fullscreenButton: RefObject<HTMLButtonElement | null>;
}

/** The resource toolbar survives Focus; it carries the two display controls (§5). */
export function ResourceToolbar({
  title,
  focus,
  fullscreen,
  notice,
  onFocus,
  onFullscreen,
  focusButton,
  fullscreenButton,
}: ResourceToolbarProps) {
  return (
    <>
      <div className={styles.toolbar} role="toolbar" aria-label="Resource tools">
        <span className={styles.title}>{title}</span>
        <div className={styles.tools}>
          <button type="button" ref={fullscreenButton} aria-keyshortcuts="f" onClick={onFullscreen}>
            {fullscreen ? 'Exit full screen' : 'Full screen'}
          </button>
          <button type="button" ref={focusButton} aria-pressed={focus} onClick={onFocus}>
            {focus ? 'Exit focus' : 'Focus'}
          </button>
        </div>
      </div>
      {notice ? (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      ) : null}
    </>
  );
}

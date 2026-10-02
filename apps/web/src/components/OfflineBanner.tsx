import { useSyncExternalStore } from 'react';
import styles from './Page.module.css';

const subscribe = (notify: () => void) => {
  window.addEventListener('online', notify);
  window.addEventListener('offline', notify);
  return () => {
    window.removeEventListener('online', notify);
    window.removeEventListener('offline', notify);
  };
};

/** The browser's own connectivity signal; true when it cannot tell. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}

/** Shown over a loaded reading while the browser is offline (§14); the reading stays usable. */
export function OfflineBanner({ children }: { children: string }) {
  if (useOnline()) return null;
  return (
    <div className={`${styles.feedback} ${styles.offline}`} role="status">
      <p>{children}</p>
    </div>
  );
}

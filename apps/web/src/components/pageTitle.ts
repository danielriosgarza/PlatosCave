import { useEffect } from 'react';

export const APP_NAME = 'Parallax';

/**
 * Sets `document.title` to "<title> · Parallax" while the page is mounted and restores the bare
 * name when it leaves. `undefined` leaves the title alone (still loading, or a child sets it).
 */
export function usePageTitle(title: string | undefined) {
  useEffect(() => {
    if (!title) return;
    document.title = `${title} · ${APP_NAME}`;
    return () => {
      document.title = APP_NAME;
    };
  }, [title]);
}

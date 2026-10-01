import { useCallback, useEffect, useRef } from 'react';
import type { ReadingPosition } from './readings';

/**
 * Collects position changes while someone reads. A change is sent once reading pauses
 * (`delayMs`) with `onPlace`; one still waiting when the reader unmounts, the page is hidden or
 * closed goes to `onFlush` instead, which must not touch the address (the move that unmounted
 * the reader may be a navigation of its own).
 */
export function useReporter(
  onPlace: (position: ReadingPosition) => void,
  onFlush: (position: ReadingPosition) => void,
  delayMs = 300,
) {
  const pending = useRef<ReadingPosition | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const place = useRef(onPlace);
  const flush = useRef(onFlush);
  place.current = onPlace;
  flush.current = onFlush;

  const send = useCallback((via: typeof place) => {
    window.clearTimeout(timer.current);
    const position = pending.current;
    pending.current = null;
    if (position) via.current(position);
  }, []);

  const report = useCallback(
    (position: ReadingPosition) => {
      pending.current = position;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => send(place), delayMs);
    },
    [send, delayMs],
  );

  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === 'hidden') send(flush);
    };
    const close = () => send(flush);
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', close);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', close);
      send(flush);
    };
  }, [send]);

  return report;
}

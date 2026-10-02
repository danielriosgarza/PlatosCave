import { useCallback, useEffect, useRef } from 'react';
import type { ReadingPosition } from './readings';

/** Why a place is handed on: reading paused, the page was hidden, or it is being closed. */
export type PlaceReason = 'pause' | 'hide' | 'close';

/**
 * Collects position changes while someone reads. A change is sent once reading pauses
 * (`delayMs`) with `onPlace`; one still waiting when the page is hidden or closed goes to
 * `onPlace` at once with that reason, to be sent without waiting. One still waiting when the reader unmounts goes to
 * `onLeave` instead, which must not touch the address: the move that unmounted the reader may
 * be a navigation of its own.
 */
export function useReporter(
  onPlace: (position: ReadingPosition, reason: PlaceReason) => void,
  onLeave: (position: ReadingPosition) => void,
  /** Called whenever the page is hidden or closed, after any waiting change went to `onPlace`. */
  onHide: () => void = () => {},
  delayMs = 300,
) {
  const pending = useRef<ReadingPosition | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const place = useRef(onPlace);
  const leave = useRef(onLeave);
  const hidden = useRef(onHide);
  place.current = onPlace;
  leave.current = onLeave;
  hidden.current = onHide;

  const take = useCallback(() => {
    window.clearTimeout(timer.current);
    const position = pending.current;
    pending.current = null;
    return position;
  }, []);

  const report = useCallback(
    (position: ReadingPosition) => {
      pending.current = position;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        const due = take();
        if (due) place.current(due, 'pause');
      }, delayMs);
    },
    [take, delayMs],
  );

  useEffect(() => {
    const hide = () => {
      if (document.visibilityState !== 'hidden') return;
      const due = take();
      if (due) place.current(due, 'hide');
      hidden.current();
    };
    const close = () => {
      const due = take();
      if (due) place.current(due, 'close');
      hidden.current();
    };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', close);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', close);
      const due = take();
      if (due) leave.current(due);
    };
  }, [take]);

  return report;
}

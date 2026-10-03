import { useEffect, useRef } from 'react';

/**
 * What a reader scrolls in: the document, or the topic workspace while it is shown full screen
 * (`Page.module.css` makes it the scroll container then). Looked up at each use, because full
 * screen comes and goes while the reader stays mounted.
 */
export interface Scroller {
  /** How far it is scrolled. */
  readonly top: number;
  /** Viewport y of its top edge: the top of the reading window that places are measured from. */
  readonly origin: number;
  scrollTo(top: number): void;
}

const fullScreenAround = (reader: Element | null): HTMLElement | null => {
  const full = document.fullscreenElement;
  return full instanceof HTMLElement && reader !== null && full.contains(reader) ? full : null;
};

export function scrollerOf(reader: Element | null): Scroller {
  const full = fullScreenAround(reader);
  if (full) {
    return {
      top: full.scrollTop,
      origin: full.getBoundingClientRect().top,
      scrollTo: (top) => full.scrollTo({ top }),
    };
  }
  return { top: window.scrollY, origin: 0, scrollTo: (top) => window.scrollTo({ top }) };
}

/**
 * Calls `listener` when the reader's scroller scrolls. An element's scroll event does not bubble,
 * so the full-screen workspace is heard in the capture phase; the document's reaches `window`.
 */
export function onScrollerScroll(reader: () => Element | null, listener: () => void): () => void {
  const element = (event: Event) => {
    const full = fullScreenAround(reader());
    if (full && event.target === full) listener();
  };
  const page = () => {
    if (!fullScreenAround(reader())) listener();
  };
  document.addEventListener('scroll', element, { capture: true, passive: true });
  window.addEventListener('scroll', page, { passive: true });
  return () => {
    document.removeEventListener('scroll', element, { capture: true });
    window.removeEventListener('scroll', page);
  };
}

/** Whether the reader is inside the element shown full screen. */
export const inFullScreen = (reader: Element | null): boolean => fullScreenAround(reader) !== null;

/**
 * Follows the reader's scroller for a reader that stays mounted while full screen comes and goes.
 * `onScroll` is called for the reader's own scrolling only: entering or leaving full screen
 * scrolls the old container first, and that is not the reader. `onFullScreen` is called when this
 * reader moves in or out of full screen; another element doing so is ignored.
 */
export function useReaderScroll(
  reader: () => Element | null,
  onScroll: () => void,
  onFullScreen: () => void,
) {
  const read = useRef(reader);
  const scrolled = useRef(onScroll);
  const changed = useRef(onFullScreen);
  read.current = reader;
  scrolled.current = onScroll;
  changed.current = onFullScreen;
  useEffect(() => {
    let full = inFullScreen(read.current());
    const stopScroll = onScrollerScroll(
      () => read.current(),
      () => {
        if (inFullScreen(read.current()) !== full) return;
        scrolled.current();
      },
    );
    const onChange = () => {
      const now = inFullScreen(read.current());
      if (now === full) return;
      full = now;
      changed.current();
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      stopScroll();
      document.removeEventListener('fullscreenchange', onChange);
    };
  }, []);
}

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { openPdf, type PdfDocument, type RenderHandle } from './pdfjs';
import styles from './Reading.module.css';
import { HOLD_MS, READER_INPUT } from './readerInput';
import type { ReadingPosition } from './readings';
import { inFullScreen, onScrollerScroll, scrollerOf } from './scroller';

interface Props {
  url: string;
  pageCount: number;
  /** Mints a new content link; the one in hand expires after five minutes (§13). */
  renew: () => Promise<string | null>;
  initial: ReadingPosition | null;
  onPosition: (position: ReadingPosition) => void;
}

const MAX_WIDTH = 960;

/**
 * Fetches with a simple request (no `Range`, no headers): the content origin answers no
 * preflight. Any failure may be an expired token whose 404 the browser hides behind a network
 * error, so the caller renews the link and tries once more.
 */
async function fetchPdf(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PDF request answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

type Load = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; doc: PdfDocument };

/**
 * A PDF reading drawn by pdf.js, one page at a time, fitted to the stage width with a text
 * layer. The place is the page and the share of its height above the window top, in thousandths.
 */
export function PdfReading({ url, pageCount, renew, initial, onPosition }: Props) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const start = initial && 'page' in initial ? initial : null;
  const [page, setPage] = useState(() => Math.min(Math.max(start?.page ?? 1, 1), pageCount));
  const [width, setWidth] = useState(0);
  const [drawn, setDrawn] = useState<{ page: number; width: number } | null>(null);
  // A callback ref, so the width follows whichever element is the stage now, including one a
  // Try again after a failed load puts in place.
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const restore = useRef<number | null>(start?.offset ?? null);
  // The share of the page above the window top as last seen, kept across full screen changes.
  const share = useRef(start?.offset ?? 0);
  const moved = useRef(false);
  const settledAt = useRef<number | null>(null);
  const current = useRef(url);
  current.current = url;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry trigger
  useEffect(() => {
    let cancelled = false;
    let opened: PdfDocument | null = null;
    setLoad({ state: 'loading' });
    (async () => {
      let bytes: Uint8Array;
      try {
        bytes = await fetchPdf(current.current);
      } catch {
        const fresh = await renew();
        if (!fresh) throw new Error('no link');
        bytes = await fetchPdf(fresh);
      }
      opened = await openPdf(bytes);
      if (cancelled) return opened.destroy();
      setLoad({ state: 'ready', doc: opened });
    })().catch(() => {
      if (!cancelled) setLoad({ state: 'failed' });
    });
    return () => {
      cancelled = true;
      opened?.destroy();
    };
  }, [attempt, renew]);

  useLayoutEffect(() => {
    if (!stage) return;
    const measure = () => setWidth(Math.min(stage.clientWidth || MAX_WIDTH, MAX_WIDTH));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [stage]);

  /** Scrolls so `wanted` thousandths of the drawn page are above the top of the window. */
  const scrollToShare = useCallback((wanted: number) => {
    const el = sheet.current;
    if (!el) return;
    const scroller = scrollerOf(el);
    const rect = el.getBoundingClientRect();
    scroller.scrollTo(scroller.top + rect.top - scroller.origin + (wanted / 1000) * rect.height);
  }, []);

  const doc = load.state === 'ready' ? load.doc : null;
  // Draws run one after another on the one canvas: pdf.js refuses a second render() while one is
  // still running, so a newer draw cancels the older and starts only after it has settled.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (!doc || !width || !canvas.current || !text.current) return;
    const target = { canvas: canvas.current, text: text.current };
    let cancelled = false;
    let handle: RenderHandle | null = null;
    queue.current = queue.current
      .then(async () => {
        if (cancelled) return;
        handle = doc.renderPage(page, target, width);
        const size = await handle.done;
        if (cancelled || !size) return;
        setDrawn({ page, width });
        settledAt.current = performance.now();
        const wanted = restore.current;
        restore.current = null;
        if (wanted !== null) scrollToShare(wanted);
      })
      .catch(() => {
        if (!cancelled) setLoad({ state: 'failed' });
      });
    return () => {
      cancelled = true;
      handle?.cancel();
    };
  }, [doc, page, width, scrollToShare]);

  const place = useCallback(() => {
    const el = sheet.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const above = scrollerOf(el).origin - rect.top;
    const through = rect.height > 0 ? Math.min(1, Math.max(0, above / rect.height)) : 0;
    share.current = Math.round(through * 1000);
    onPosition({ page, offset: share.current });
  }, [page, onPosition]);

  // Only a reader's scrolling moves the saved place; the page being drawn or the router
  // resetting the scroll must not (see NativeReading).
  useEffect(() => {
    const input = () => {
      moved.current = true;
    };
    let full = inFullScreen(sheet.current);
    const onScroll = () => {
      // Entering or leaving full screen scrolls the old container first; that is not the reader.
      if (inFullScreen(sheet.current) !== full) return;
      const at = settledAt.current;
      // Not before the page is drawn and its place restored, and not in the moment after it.
      if (at === null) return;
      if (moved.current || performance.now() - at > HOLD_MS) place();
    };
    const onFullScreen = () => {
      full = inFullScreen(sheet.current);
      if (settledAt.current !== null) scrollToShare(share.current);
    };
    for (const type of READER_INPUT) window.addEventListener(type, input, { passive: true });
    const stopScroll = onScrollerScroll(() => sheet.current, onScroll);
    document.addEventListener('fullscreenchange', onFullScreen);
    return () => {
      for (const type of READER_INPUT) window.removeEventListener(type, input);
      stopScroll();
      document.removeEventListener('fullscreenchange', onFullScreen);
    };
  }, [place, scrollToShare]);

  const go = (next: number) => {
    const target = Math.min(Math.max(next, 1), pageCount);
    if (target === page) return;
    setPage(target);
    restore.current = 0;
    share.current = 0;
    onPosition({ page: target, offset: 0 });
  };

  if (load.state === 'failed') {
    return (
      <div className={styles.notice} role="alert">
        <p>This PDF could not be loaded.</p>
        <button type="button" className={styles.button} onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className={styles.pdf} ref={setStage}>
      <nav className={styles.pageControls} aria-label="PDF pages">
        <button
          type="button"
          className={styles.button}
          disabled={page <= 1}
          onClick={() => go(page - 1)}
        >
          Previous page
        </button>
        <span className={styles.pageCount} aria-live="polite">
          Page {page} of {pageCount}
        </span>
        <button
          type="button"
          className={styles.button}
          disabled={page >= pageCount}
          onClick={() => go(page + 1)}
        >
          Next page
        </button>
      </nav>
      {load.state === 'loading' && (
        <p className={styles.loading} role="status">
          Loading reading
        </p>
      )}
      <div
        ref={sheet}
        className={styles.sheet}
        data-page={drawn?.page}
        hidden={load.state !== 'ready'}
        style={drawn ? { width: drawn.width } : undefined}
      >
        <canvas ref={canvas} aria-label={`Page ${page}`} />
        {/* pdf.js finds its text layer by the plain `textLayer` class while a selection is made. */}
        <div ref={text} className={`${styles.textLayer} textLayer`} />
      </div>
    </div>
  );
}

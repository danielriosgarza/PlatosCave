import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { openPdf, type PdfDocument } from './pdfjs';
import styles from './Reading.module.css';
import { READER_INPUT } from './readerInput';
import type { ReadingPosition } from './readings';

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
  const stage = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const restore = useRef<number | null>(start?.offset ?? null);
  const moved = useRef(false);
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
    const el = stage.current;
    if (!el) return;
    const measure = () => setWidth(Math.min(el.clientWidth || MAX_WIDTH, MAX_WIDTH));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const doc = load.state === 'ready' ? load.doc : null;
  useEffect(() => {
    if (!doc || !width || !canvas.current || !text.current) return;
    let cancelled = false;
    doc
      .renderPage(page, { canvas: canvas.current, text: text.current }, width)
      .then(() => {
        if (cancelled) return;
        setDrawn({ page, width });
        const share = restore.current;
        restore.current = null;
        const el = sheet.current;
        if (el && share !== null) {
          const rect = el.getBoundingClientRect();
          window.scrollTo({ top: window.scrollY + rect.top + (share / 1000) * rect.height });
        }
      })
      .catch(() => {
        if (!cancelled) setLoad({ state: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, [doc, page, width]);

  const place = useCallback(() => {
    const el = sheet.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const through = rect.height > 0 ? Math.min(1, Math.max(0, -rect.top / rect.height)) : 0;
    onPosition({ page, offset: Math.round(through * 1000) });
  }, [page, onPosition]);

  // Only a reader's scrolling moves the saved place; the page being drawn or the router
  // resetting the scroll must not (see NativeReading).
  useEffect(() => {
    const input = () => {
      moved.current = true;
    };
    const onScroll = () => {
      if (moved.current) place();
    };
    for (const type of READER_INPUT) window.addEventListener(type, input, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      for (const type of READER_INPUT) window.removeEventListener(type, input);
      window.removeEventListener('scroll', onScroll);
    };
  }, [place]);

  const go = (next: number) => {
    const target = Math.min(Math.max(next, 1), pageCount);
    if (target === page) return;
    setPage(target);
    restore.current = 0;
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
    <div className={styles.pdf} ref={stage}>
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
        <div ref={text} className="textLayer" />
      </div>
    </div>
  );
}

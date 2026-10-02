import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { openPdf, type PdfDocument, type RenderHandle } from '../reading/pdfjs';
import readingStyles from '../reading/Reading.module.css';
import { SourceDownload } from '../reading/SourceDownload';
import { isEditable, useFocusActive } from '../workspace/focus';
import { ResourceTools } from '../workspace/ResourceTools';
import styles from './Slides.module.css';

/** Zoom steps over the fitted size; 1 is fit. */
export const ZOOMS = [1, 1.5, 2, 3] as const;

export interface NotesContext {
  revisionId: string;
  /** The slide shown, 1-based: the notes follow it. */
  page: number;
}

interface Props {
  url: string;
  pageCount: number;
  /** Mints a new content link; the one in hand expires after five minutes (§13). */
  renew: () => Promise<string | null>;
  /** The slide to open at, 1-based. */
  initialPage: number;
  source: { classId: string; revisionId: string; key: string | null };
  onPage: (page: number) => void;
  /** The deck picker, shown at the start of the local toolbar when a topic has several decks. */
  picker?: ReactNode;
  title: string;
  /** Fills the notes margin for the slide shown (P2-09); without it the viewer has no Notes control. */
  notes?: (context: NotesContext) => ReactNode;
}

type Load = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; doc: PdfDocument };

/**
 * A PDF deck drawn by pdf.js one slide at a time (§7): the file is opened over its content link
 * with range requests, so a slide costs only the bytes it needs. The slide keeps the file's
 * ratio inside a neutral stage; arrow keys move it only while the stage holds focus.
 */
export function SlideViewer({
  url,
  pageCount,
  renew,
  initialPage,
  source,
  onPage,
  picker,
  title,
  notes,
}: Props) {
  const focusMode = useFocusActive();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(() => Math.min(Math.max(initialPage, 1), pageCount));
  const [zoom, setZoom] = useState(0);
  const [indexOpen, setIndexOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // A callback ref, so the size follows whichever element is the mat now, including one a
  // Try again after a failed load puts in place.
  const [mat, setMat] = useState<HTMLDivElement | null>(null);
  const stage = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState<{ width: number; height: number } | null>(null);
  const current = useRef(url);
  current.current = url;
  // A link that has just been opened and has drawn nothing yet: a failure then is not expiry.
  const fresh = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry trigger
  useEffect(() => {
    let cancelled = false;
    let opened: PdfDocument | null = null;
    setLoad({ state: 'loading' });
    (async () => {
      try {
        opened = await openPdf(current.current);
      } catch {
        const next = await renew();
        if (!next) throw new Error('no link');
        current.current = next;
        opened = await openPdf(next);
      }
      if (cancelled) return opened.destroy();
      fresh.current = true;
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
    if (!mat) return;
    const measure = () => setSize({ width: mat.clientWidth, height: mat.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(mat);
    return () => observer.disconnect();
  }, [mat]);

  const doc = load.state === 'ready' ? load.doc : null;
  const level = ZOOMS[zoom] ?? 1;
  // Draws run one after another on the one canvas: pdf.js refuses a second render() while one is
  // still running, so a newer draw cancels the older and starts only after it has settled.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (!doc || !size.width || !size.height || !canvas.current || !text.current) return;
    const target = { canvas: canvas.current, text: text.current };
    let cancelled = false;
    let handle: RenderHandle | null = null;
    queue.current = queue.current
      .then(async () => {
        if (cancelled) return;
        const ratio = await doc.pageRatio(page);
        if (cancelled) return;
        // Fit: the whole slide inside the stage, never distorted.
        const fit = Math.min(size.width, size.height * ratio);
        handle = doc.renderPage(page, target, Math.max(1, Math.floor(fit * level)));
        const done = await handle.done;
        if (cancelled || !done) return;
        fresh.current = false;
        setDrawn(done);
      })
      .catch(() => {
        if (cancelled) return;
        // After the content link has expired, pages not yet read fail: open the deck again on
        // a new link once, and fail only if that does not draw.
        if (fresh.current) setLoad({ state: 'failed' });
        else setAttempt((n) => n + 1);
      });
    return () => {
      cancelled = true;
      handle?.cancel();
    };
  }, [doc, page, size, level]);

  // A new slide opens at the top left of the stage, however far the last was panned.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the slide is the trigger
  useEffect(() => {
    if (!mat) return;
    mat.scrollLeft = 0;
    mat.scrollTop = 0;
  }, [page, mat]);

  const go = useCallback(
    (next: number) => {
      const target = Math.min(Math.max(next, 1), pageCount);
      if (target === page) return;
      setPage(target);
      onPage(target);
      // Focus stays on the viewer after every change, so repeated arrow presses keep working
      // even when the control that was used becomes disabled.
      stage.current?.focus({ preventScroll: true });
    },
    [page, pageCount, onPage],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey
    ) {
      return;
    }
    if (isEditable(event.target)) return;
    if (event.key === 'ArrowRight') go(page + 1);
    else if (event.key === 'ArrowLeft') go(page - 1);
    else return;
    event.preventDefault();
  };

  const tools = (
    <ResourceTools>
      {picker ?? <span className={styles.label}>{title}</span>}
      <button
        type="button"
        className={styles.button}
        aria-expanded={indexOpen}
        aria-controls="pc-slide-index"
        onClick={() => setIndexOpen((open) => !open)}
      >
        Slide index
      </button>
      <button
        type="button"
        className={styles.button}
        disabled={zoom <= 0}
        onClick={() => setZoom((z) => Math.max(0, z - 1))}
      >
        Zoom out
      </button>
      <button
        type="button"
        className={styles.button}
        disabled={zoom >= ZOOMS.length - 1}
        onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))}
      >
        Zoom in
      </button>
      <button
        type="button"
        className={styles.button}
        disabled={zoom === 0}
        onClick={() => setZoom(0)}
      >
        Fit
      </button>
      {zoom > 0 && (
        <span className={styles.label} role="status">
          Zoom {Math.round(level * 100)}%
        </span>
      )}
      {notes && (
        <button
          type="button"
          className={styles.button}
          aria-pressed={notesOpen}
          onClick={() => setNotesOpen((open) => !open)}
        >
          {notesOpen ? 'Hide notes' : 'Notes'}
        </button>
      )}
    </ResourceTools>
  );

  if (load.state === 'failed') {
    return (
      <div className={styles.stage}>
        <div className={styles.notice} role="alert">
          <p>These slides could not be loaded.</p>
          <button type="button" className={styles.button} onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
          {source.key && (
            <SourceDownload
              classId={source.classId}
              revisionId={source.revisionId}
              sourceKey={source.key}
            />
          )}
        </div>
      </div>
    );
  }

  const withNotes = notes !== undefined && notesOpen;
  return (
    <>
      {tools}
      <section
        ref={stage}
        className={styles.stage}
        data-focus={focusMode || undefined}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the stage owns the arrow keys, so it takes focus
        tabIndex={0}
        aria-label="Slide viewer"
        onKeyDown={onKeyDown}
      >
        <div className={`${styles.grid} ${withNotes ? styles.hasNotes : ''}`}>
          <div className={styles.main}>
            <div
              ref={setMat}
              data-slide-stage=""
              className={styles.mat}
              data-zoomed={zoom > 0 || undefined}
              data-focus={focusMode || undefined}
            >
              {load.state === 'loading' && (
                <p className={styles.loading} role="status">
                  Loading slides
                </p>
              )}
              <div
                className={styles.slide}
                data-page={drawn ? page : undefined}
                hidden={load.state !== 'ready'}
                style={drawn ? { width: drawn.width, height: drawn.height } : undefined}
              >
                <canvas ref={canvas} aria-label={`Slide ${page} of ${pageCount}`} />
                {/* pdf.js finds its text layer by the plain `textLayer` class while a selection is made. */}
                <div ref={text} className={`${readingStyles.textLayer} textLayer`} />
              </div>
            </div>
            <div
              className={styles.progress}
              role="progressbar"
              aria-label="Slide position"
              aria-valuemin={1}
              aria-valuemax={pageCount}
              aria-valuenow={page}
            >
              <span style={{ width: `${(page / pageCount) * 100}%` }} />
            </div>
            <div className={styles.controls}>
              <button
                type="button"
                className={`${styles.button} ${styles.first}`}
                disabled={page <= 1}
                onClick={() => go(page - 1)}
              >
                Previous
              </button>
              <span className={styles.count} aria-live="polite">
                {page} / {pageCount}
              </span>
              <button
                type="button"
                className={styles.button}
                disabled={page >= pageCount}
                onClick={() => go(page + 1)}
              >
                Next
              </button>
              {source.key && (
                <SourceDownload
                  classId={source.classId}
                  revisionId={source.revisionId}
                  sourceKey={source.key}
                  className={styles.button}
                />
              )}
            </div>
            {indexOpen && (
              <ol className={styles.index} id="pc-slide-index" aria-label="Slides">
                {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
                  <li key={n}>
                    <button
                      type="button"
                      className={styles.indexButton}
                      aria-label={`Slide ${n}`}
                      aria-current={n === page}
                      onClick={() => go(n)}
                    >
                      {n}
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
          {withNotes && (
            <aside className={styles.notes} aria-label="Slide notes">
              {notes({ revisionId: source.revisionId, page })}
            </aside>
          )}
        </div>
      </section>
    </>
  );
}

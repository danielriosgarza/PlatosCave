import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import styles from './Reading.module.css';
import { HOLD_MS, READER_INPUT } from './readerInput';
import type { ReadingPosition } from './readings';
import { sanitizeReading } from './sanitize';
import { inFullScreen, onScrollerScroll, scrollerOf } from './scroller';

interface Props {
  /** Sanitised at ingestion (P1-08) and image links resolved by the server at read time. */
  html: string;
  initial: ReadingPosition | null;
  onPosition: (position: ReadingPosition) => void;
}

type BlockPlace = { blockId: string; offset: number };

const blocks = (root: HTMLElement) => root.querySelectorAll<HTMLElement>('[data-block-id]');

/** The block at the top of the reading window and how far into its text that top reaches. */
export function currentBlock(root: HTMLElement): ReadingPosition | null {
  const origin = scrollerOf(root).origin;
  for (const block of blocks(root)) {
    const rect = block.getBoundingClientRect();
    if (rect.bottom - origin <= 1) continue;
    const length = block.textContent?.length ?? 0;
    const above = origin - rect.top;
    const through = rect.height > 0 ? Math.min(1, Math.max(0, above / rect.height)) : 0;
    return { blockId: block.dataset.blockId ?? '', offset: Math.round(length * through) };
  }
  return null;
}

/**
 * Scrolls so the named block (and the share of its text before `offset`) is at the top, unless
 * it already is. Returns false when the block is not in the document.
 */
function scrollToBlock(root: HTMLElement, position: BlockPlace) {
  const block = [...blocks(root)].find((b) => b.dataset.blockId === position.blockId);
  if (!block) return false;
  const scroller = scrollerOf(root);
  const rect = block.getBoundingClientRect();
  const length = block.textContent?.length ?? 0;
  const through = length > 0 ? Math.min(1, position.offset / length) : 0;
  const top = scroller.top + rect.top - scroller.origin + through * rect.height;
  if (Math.abs(top - scroller.top) >= 1) scroller.scrollTo(top);
  return true;
}

/**
 * A native reading inside the reading measure. The place is the block under the top of the
 * reading window plus a character offset into it, so it survives reflow and zoom (§8). Until the
 * reader first scrolls, the saved place is held for a moment: the router's scroll to the top
 * after arriving from another page, a browser's restoration and images that load late all move
 * the page, and none may overwrite the place with where they left it. The HTML is sanitised once
 * more here before it is inserted (ADR-0002 §Readings on the app origin).
 */
export function NativeReading({ html, initial, onPosition }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const openedAt = useRef(performance.now());
  const start = useRef(initial && 'blockId' in initial ? initial : null);
  // Where the reader is, so new HTML for the same reading (fresh image links after a background
  // refetch) or a move in or out of full screen keeps the place instead of returning to `start`.
  const here = useRef<BlockPlace | null>(start.current);
  // What the hold keeps in view: the saved place at first, the reader's place after new HTML.
  const target = useRef<BlockPlace | null>(start.current);
  const restored = useRef(false);
  const shown = useMemo(() => sanitizeReading(html), [html]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the inserted HTML changes
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    if (restored.current) {
      // New HTML replaces the page under the reader, and its images load again: hold the place
      // the reader was at, as on first opening.
      target.current = here.current;
      moved.current = false;
      openedAt.current = performance.now();
    }
    restored.current = true;
    if (target.current) scrollToBlock(root, target.current);
  }, [shown]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let full = inFullScreen(root);
    const settling = () => !moved.current && performance.now() - openedAt.current < HOLD_MS;
    const hold = () => {
      if (settling() && target.current) scrollToBlock(root, target.current);
    };
    const input = () => {
      moved.current = true;
    };
    const onScroll = () => {
      // Entering or leaving full screen scrolls the old container first; that is not the reader.
      if (inFullScreen(root) !== full) return;
      if (settling()) return hold();
      const place = currentBlock(root);
      if (!place || !('blockId' in place)) return;
      here.current = place;
      onPosition(place);
    };
    const onFullScreen = () => {
      // Another element entering or leaving full screen does not move this reader.
      if (inFullScreen(root) === full) return;
      full = inFullScreen(root);
      if (here.current) scrollToBlock(root, here.current);
    };
    for (const type of READER_INPUT) window.addEventListener(type, input, { passive: true });
    const stopScroll = onScrollerScroll(() => root, onScroll);
    document.addEventListener('fullscreenchange', onFullScreen);
    root.addEventListener('load', hold, true);
    // The router scrolls to the top once the page has rendered; hold the place after that too.
    const frame = requestAnimationFrame(() => requestAnimationFrame(hold));
    return () => {
      cancelAnimationFrame(frame);
      for (const type of READER_INPUT) window.removeEventListener(type, input);
      stopScroll();
      document.removeEventListener('fullscreenchange', onFullScreen);
      root.removeEventListener('load', hold, true);
    };
  }, [onPosition]);

  return (
    <div
      ref={ref}
      className={styles.native}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitised twice with the reading allow-list: at ingestion and by sanitizeReading
      dangerouslySetInnerHTML={{ __html: shown }}
    />
  );
}

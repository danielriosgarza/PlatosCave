import { useEffect, useLayoutEffect, useRef } from 'react';
import styles from './Reading.module.css';
import { READER_INPUT } from './readerInput';
import type { ReadingPosition } from './readings';

interface Props {
  /** Sanitised at ingestion (P1-08) and image links resolved by the server at read time. */
  html: string;
  initial: ReadingPosition | null;
  onPosition: (position: ReadingPosition) => void;
}

const blocks = (root: HTMLElement) => root.querySelectorAll<HTMLElement>('[data-block-id]');

/** The block at the top of the window and how far into its text the window top reaches. */
export function currentBlock(root: HTMLElement): ReadingPosition | null {
  for (const block of blocks(root)) {
    const rect = block.getBoundingClientRect();
    if (rect.bottom <= 1) continue;
    const length = block.textContent?.length ?? 0;
    const through = rect.height > 0 ? Math.min(1, Math.max(0, -rect.top / rect.height)) : 0;
    return { blockId: block.dataset.blockId ?? '', offset: Math.round(length * through) };
  }
  return null;
}

/**
 * Scrolls so the named block (and the share of its text before `offset`) is at the top, unless
 * it already is. Returns false when the block is not in the document.
 */
function scrollToBlock(root: HTMLElement, position: { blockId: string; offset: number }) {
  const block = [...blocks(root)].find((b) => b.dataset.blockId === position.blockId);
  if (!block) return false;
  const rect = block.getBoundingClientRect();
  const length = block.textContent?.length ?? 0;
  const through = length > 0 ? Math.min(1, position.offset / length) : 0;
  const top = window.scrollY + rect.top + through * rect.height;
  if (Math.abs(top - window.scrollY) >= 1) window.scrollTo({ top });
  return true;
}

/**
 * A native reading inside the reading measure. The place is the block under the top of the
 * window plus a character offset into it, so it survives reflow and zoom (§8). Until the reader
 * first scrolls, the saved place is held: the router's own scroll to the top after a navigation,
 * a browser's restoration and images that load late all move the page, and none may overwrite
 * the place with where they left it.
 */
export function NativeReading({ html, initial, onPosition }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const start = useRef(initial && 'blockId' in initial ? initial : null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: restores once per document
  useLayoutEffect(() => {
    moved.current = false;
    const root = ref.current;
    if (root && start.current) scrollToBlock(root, start.current);
  }, [html]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const hold = () => {
      if (!moved.current && start.current) scrollToBlock(root, start.current);
    };
    const input = () => {
      moved.current = true;
    };
    const onScroll = () => {
      if (!moved.current) return hold();
      const place = currentBlock(root);
      if (place) onPosition(place);
    };
    for (const type of READER_INPUT) window.addEventListener(type, input, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    root.addEventListener('load', hold, true);
    // The router scrolls to the top once the page has rendered; hold the place after that too.
    const frame = requestAnimationFrame(() => requestAnimationFrame(hold));
    return () => {
      cancelAnimationFrame(frame);
      for (const type of READER_INPUT) window.removeEventListener(type, input);
      window.removeEventListener('scroll', onScroll);
      root.removeEventListener('load', hold, true);
    };
  }, [onPosition]);

  return (
    <div
      ref={ref}
      className={styles.native}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: reading HTML is sanitised at ingestion with the reading schema (no scripts, styles or free ids)
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

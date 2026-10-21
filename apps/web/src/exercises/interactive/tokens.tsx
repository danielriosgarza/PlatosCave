import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import styles from './Interactive.module.css';

/**
 * Tokens moved between slots (§9): the tiles of a fill-in step, the items of a sorting step,
 * the labels of a diagram. A token moves three ways, each enough on its own: drag it with a
 * pointer onto a slot; click it, then click a slot; or press it with the keyboard (Enter or
 * Space), then press a slot's "Put … here" button. Escape puts a picked token down. A polite
 * live region says what was picked and where it went.
 */

/** The slot of tokens not placed yet. */
export const BANK = '__bank';

export interface Move {
  token: string;
  from: string;
  to: string;
}

/** How far a press must travel before it is a drag rather than a click, in pixels. */
const DRAG_DISTANCE = 6;

/** The slot under a screen point, if any. */
const slotAt = (x: number, y: number) =>
  (document.elementFromPoint?.(x, y)?.closest('[data-slot]') as HTMLElement | null)?.dataset.slot ??
  null;

interface Press {
  token: string;
  from: string;
  label: string;
  x: number;
  y: number;
  pointer: number;
}

export function useTokenDrag({
  disabled,
  onMove,
  tokenLabel,
  slotLabel,
}: {
  disabled: boolean;
  onMove: (move: Move) => void;
  tokenLabel: (token: string) => string;
  slotLabel: (slot: string) => string;
}) {
  const [picked, setPicked] = useState<{ token: string; from: string } | null>(null);
  const [ghost, setGhost] = useState<{
    label: string;
    x: number;
    y: number;
    over: string | null;
  } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const press = useRef<Press | null>(null);
  const dragged = useRef(false);
  const move = useRef(onMove);
  move.current = onMove;

  const place = useCallback(
    (token: string, from: string, to: string) => {
      setPicked(null);
      if (to === from) {
        setAnnouncement(`${tokenLabel(token)} stays in ${slotLabel(to)}.`);
        return;
      }
      move.current({ token, from, to });
      setAnnouncement(`${tokenLabel(token)} put in ${slotLabel(to)}.`);
    },
    [tokenLabel, slotLabel],
  );

  useEffect(() => {
    if (!picked) return;
    const putDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setPicked(null);
      setAnnouncement(`${tokenLabel(picked.token)} put down.`);
    };
    document.addEventListener('keydown', putDown);
    return () => document.removeEventListener('keydown', putDown);
  }, [picked, tokenLabel]);

  useEffect(() => {
    if (disabled) {
      setPicked(null);
      setGhost(null);
      press.current = null;
    }
  }, [disabled]);

  useEffect(() => {
    const moved = (e: PointerEvent) => {
      const p = press.current;
      if (!p || e.pointerId !== p.pointer) return;
      if (!dragged.current && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_DISTANCE) return;
      dragged.current = true;
      e.preventDefault();
      setGhost({ label: p.label, x: e.clientX, y: e.clientY, over: slotAt(e.clientX, e.clientY) });
    };
    const released = (e: PointerEvent) => {
      const p = press.current;
      if (!p || e.pointerId !== p.pointer) return;
      press.current = null;
      setGhost(null);
      if (!dragged.current) return;
      const to = e.type === 'pointerup' ? slotAt(e.clientX, e.clientY) : null;
      if (to) place(p.token, p.from, to);
      else setAnnouncement(`${p.label} not moved.`);
    };
    window.addEventListener('pointermove', moved, { passive: false });
    window.addEventListener('pointerup', released);
    window.addEventListener('pointercancel', released);
    return () => {
      window.removeEventListener('pointermove', moved);
      window.removeEventListener('pointerup', released);
      window.removeEventListener('pointercancel', released);
    };
  }, [place]);

  /** Props of a token's button: `from` is the slot it is in. */
  const tokenProps = (token: string, from: string) => ({
    'data-token': token,
    'aria-pressed': picked?.token === token && picked.from === from,
    disabled,
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
      dragged.current = false;
      press.current = {
        token,
        from,
        label: tokenLabel(token),
        x: e.clientX,
        y: e.clientY,
        pointer: e.pointerId,
      };
    },
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      // The click that ends a drag is not a pick.
      if (dragged.current) {
        dragged.current = false;
        return;
      }
      if (picked?.token === token && picked.from === from) {
        setPicked(null);
        setAnnouncement(`${tokenLabel(token)} put down.`);
        return;
      }
      setPicked({ token, from });
      setAnnouncement(`${tokenLabel(token)} picked up. Choose where it goes, or press Escape.`);
    },
  });

  /** Props of a slot's element: a click on it puts the picked token there. */
  const slotProps = (slot: string) => ({
    'data-slot': slot,
    'data-over': ghost?.over === slot || undefined,
    onClick: () => {
      if (picked && !disabled) place(picked.token, picked.from, slot);
    },
  });

  /** A button that puts the picked token in `slot`; shown only while a token is picked. */
  const dropButton = (slot: string, className = styles.drop) =>
    picked && !disabled ? (
      <button
        type="button"
        className={className}
        onClick={(e) => {
          e.stopPropagation();
          place(picked.token, picked.from, slot);
        }}
      >
        {`Put ${tokenLabel(picked.token)} in ${slotLabel(slot)}`}
      </button>
    ) : null;

  const layer: ReactNode = (
    <>
      {ghost ? (
        <div className={styles.ghost} style={{ left: ghost.x, top: ghost.y }} aria-hidden="true">
          {ghost.label}
        </div>
      ) : null}
      <p className={styles.visuallyHidden} aria-live="polite">
        {announcement}
      </p>
    </>
  );

  return { picked, tokenProps, slotProps, dropButton, layer };
}

/** A token's face: its label, and its mark after a check that marks parts. */
export function TokenFace({ label, mark }: { label: string; mark?: boolean }) {
  return (
    <>
      <span>{label}</span>
      {mark === undefined ? null : <Mark right={mark} />}
    </>
  );
}

/** ✓ or ✗ with words for a screen reader: marks never rely on colour alone. */
export function Mark({ right }: { right: boolean }) {
  return (
    <span className={right ? styles.markRight : styles.markWrong}>
      <span aria-hidden="true">{right ? '✓' : '✗'}</span>
      <span className={styles.visuallyHidden}>{right ? ', right' : ', not right yet'}</span>
    </span>
  );
}

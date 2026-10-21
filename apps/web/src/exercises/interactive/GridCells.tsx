import type { InteractiveView } from '@parallax/contracts';
import { useEffect, useRef, useState } from 'react';
import type { InteractiveDraft } from './draft';
import styles from './Interactive.module.css';

type View = Extract<InteractiveView, { kind: 'grid' }>;
type Draft = Extract<InteractiveDraft, { kind: 'grid' }>;

const key = (r: number, c: number) => `${r},${c}`;
/** 1, 2, … n: rows and columns are counted from 1. */
const numbers = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const MOVES: Record<string, [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

/**
 * Shade cells of a grid (§9). A cell is a toggle button in a table; the grid is one tab stop and
 * the arrow keys move between cells, Space or Enter shades one. Dragging across cells shades (or clears)
 * every cell the pointer passes, as the first one went. Given cells are shaded and locked.
 */
export function GridCells({
  view,
  draft,
  disabled,
  parts,
  onChange,
}: {
  view: View;
  draft: Draft;
  disabled: boolean;
  parts?: Record<string, boolean> | null;
  onChange: (draft: Draft) => void;
}) {
  const fixed = new Set(view.fixed.map(([r, c]) => key(r, c)));
  const shaded = new Set(draft.cells.map(([r, c]) => key(r, c)));
  const [active, setActive] = useState<[number, number]>([1, 1]);
  const paint = useRef<boolean | null>(null);
  const latest = useRef(draft.cells);
  latest.current = draft.cells;
  const box = useRef<HTMLTableElement>(null);

  useEffect(() => {
    const stop = () => {
      paint.current = null;
    };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, []);

  const set = (r: number, c: number, on: boolean) => {
    if (disabled || fixed.has(key(r, c))) return;
    const rest = latest.current.filter(([a, b]) => key(a, b) !== key(r, c));
    latest.current = on ? [...rest, [r, c]] : rest;
    onChange({ kind: 'grid', cells: latest.current });
  };
  const focus = (r: number, c: number) => {
    setActive([r, c]);
    box.current?.querySelector<HTMLButtonElement>(`[data-cell="${key(r, c)}"]`)?.focus();
  };
  const count = shaded.size + fixed.size;

  return (
    <div className={styles.board}>
      <table ref={box} className={styles.cells} style={{ maxWidth: view.cols * 56 }}>
        <caption className={styles.visuallyHidden}>
          {`Grid of ${view.rows} rows and ${view.cols} columns. The arrow keys move between cells; Space shades or clears one.`}
        </caption>
        <tbody>
          {numbers(view.rows).map((r) => (
            <tr key={r}>
              {numbers(view.cols).map((c) => {
                const given = fixed.has(key(r, c));
                const on = given || shaded.has(key(r, c));
                const mark = parts?.[key(r, c)];
                const isActive = active[0] === r && active[1] === c;
                return (
                  <td key={c}>
                    <button
                      type="button"
                      data-cell={key(r, c)}
                      data-mark={mark}
                      className={given ? `${styles.cell} ${styles.cellGiven}` : styles.cell}
                      aria-pressed={on}
                      aria-label={`Row ${r}, column ${c}${given ? ', given' : ''}${mark === undefined ? '' : mark ? ', right' : ', not right yet'}`}
                      aria-disabled={disabled || given || undefined}
                      tabIndex={isActive ? 0 : -1}
                      onFocus={() => setActive([r, c])}
                      onPointerDown={(e) => {
                        if (disabled || given || (e.pointerType === 'mouse' && e.button !== 0))
                          return;
                        // Release the implicit touch capture so the cells under the finger see it.
                        e.currentTarget.releasePointerCapture?.(e.pointerId);
                        paint.current = !on;
                        set(r, c, !on);
                      }}
                      onPointerEnter={() => {
                        if (paint.current !== null) set(r, c, paint.current);
                      }}
                      onClick={(e) => {
                        // Pointer presses shade on pointer down; this is the keyboard's Space or Enter.
                        if (e.detail === 0) set(r, c, !on);
                      }}
                      onKeyDown={(e) => {
                        const by = MOVES[e.key];
                        if (!by) return;
                        e.preventDefault();
                        focus(
                          Math.min(view.rows, Math.max(1, r + by[0])),
                          Math.min(view.cols, Math.max(1, c + by[1])),
                        );
                      }}
                    >
                      {mark === undefined ? null : (
                        <span aria-hidden="true">{mark ? '✓' : '✗'}</span>
                      )}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.readout} aria-live="polite">
        {`${count} of ${view.rows * view.cols} cells shaded`}
      </p>
    </div>
  );
}

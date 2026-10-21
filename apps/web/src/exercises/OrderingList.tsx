import { useRef, useState } from 'react';
import buttons from '../components/Buttons.module.css';
import styles from './Exercise.module.css';

/**
 * Items to put in order (§9): drag an item by its grip to its place, or move it with its Up and
 * Down buttons, which are the keyboard's way. The list reorders under the pointer as it moves.
 */
export function OrderingList({
  order,
  labels,
  disabled,
  onChange,
}: {
  order: string[];
  labels: Map<string, string>;
  disabled: boolean;
  onChange: (order: string[]) => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const latest = useRef(order);
  latest.current = order;
  const name = (id: string) => labels.get(id) ?? id;

  const moveTo = (id: string, to: number) => {
    const from = latest.current.indexOf(id);
    if (from === -1 || from === to) return;
    const next = [...latest.current];
    next.splice(from, 1);
    next.splice(to, 0, id);
    latest.current = next;
    onChange(next);
  };

  return (
    <ol className={styles.sortable}>
      {order.map((id, i) => (
        <li key={id} data-item={id} data-dragging={dragging === id || undefined}>
          {disabled ? null : (
            <span
              className={styles.grip}
              aria-hidden="true"
              onPointerDown={(e) => {
                if (e.pointerType === 'mouse' && e.button !== 0) return;
                e.preventDefault();
                e.currentTarget.setPointerCapture?.(e.pointerId);
                setDragging(id);
              }}
              onPointerMove={(e) => {
                if (dragging !== id) return;
                const over = (
                  document.elementFromPoint?.(e.clientX, e.clientY)?.closest('[data-item]') as
                    | HTMLElement
                    | null
                    | undefined
                )?.dataset.item;
                if (over && over !== id) moveTo(id, latest.current.indexOf(over));
              }}
              onPointerUp={() => setDragging(null)}
              onPointerCancel={() => setDragging(null)}
            >
              ⠿
            </span>
          )}
          <span className={styles.sortLabel}>{name(id)}</span>
          <span className={styles.nudge}>
            <button
              type="button"
              className={buttons.outline}
              disabled={disabled || i === 0}
              aria-label={`Move ${name(id)} up`}
              onClick={() => moveTo(id, i - 1)}
            >
              Up
            </button>
            <button
              type="button"
              className={buttons.outline}
              disabled={disabled || i === order.length - 1}
              aria-label={`Move ${name(id)} down`}
              onClick={() => moveTo(id, i + 1)}
            >
              Down
            </button>
          </span>
        </li>
      ))}
    </ol>
  );
}

import type { KeyboardEvent, PointerEvent } from 'react';
import { type Frame, round, toWorld, type XY } from './geometry';
import styles from './Interactive.module.css';

/** A pointer position over an SVG element, in the scene frame's pixels. */
export function framePoint(svg: SVGSVGElement, frame: Frame, clientX: number, clientY: number): XY {
  const rect = svg.getBoundingClientRect();
  const sx = rect.width > 0 ? frame.width / rect.width : 1;
  const sy = rect.height > 0 ? frame.height / rect.height : 1;
  return [(clientX - rect.left) * sx, (clientY - rect.top) * sy];
}

/** The world point under a pointer event on an element of a scene. */
export function worldAt(e: PointerEvent<SVGElement>, frame: Frame): XY | null {
  const svg =
    e.currentTarget instanceof SVGSVGElement ? e.currentTarget : e.currentTarget.ownerSVGElement;
  return svg ? toWorld(frame, framePoint(svg, frame, e.clientX, e.clientY)) : null;
}

/** Arrow keys as steps: [dx, dy] in grid steps, ten at a time with Page Up and Page Down. */
export function keySteps(e: KeyboardEvent): [number, number] | null {
  const big = e.shiftKey ? 5 : 1;
  switch (e.key) {
    case 'ArrowLeft':
      return [-big, 0];
    case 'ArrowRight':
      return [big, 0];
    case 'ArrowUp':
      return [0, big];
    case 'ArrowDown':
      return [0, -big];
    case 'PageUp':
      return [0, 10];
    case 'PageDown':
      return [0, -10];
    default:
      return null;
  }
}

/**
 * A point the learner moves: dragged with a pointer, or focused and moved with the arrow keys.
 * It is a slider to assistive technology, with its position as the value text; the hit area is
 * larger than the dot so a finger can take it.
 */
export function Handle({
  frame,
  at,
  name,
  valueText,
  valueNow,
  range,
  orientation,
  disabled,
  mark,
  tabIndex = 0,
  onDrag,
  onKey,
  onFocus,
  showName = true,
  handleId,
}: {
  frame: Frame;
  at: XY;
  name: string;
  valueText: string;
  valueNow: number;
  range: [number, number];
  orientation?: 'horizontal' | 'vertical';
  disabled: boolean;
  mark?: boolean;
  tabIndex?: number;
  /** A world position under the pointer while the handle is dragged. */
  onDrag: (world: XY) => void;
  /** Arrow key steps, already read as [dx, dy]; return true when handled. */
  onKey: (steps: [number, number], e: KeyboardEvent<SVGGElement>) => boolean | undefined;
  onFocus?: () => void;
  showName?: boolean;
  /** Set as `data-handle`, so a form can move focus to the handle. */
  handleId?: string;
}) {
  const [x, y] = frame.toScreen(at);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return (
    // A slider's children are presentational: its name and value text say what they draw.
    <g
      className={disabled ? styles.handle : `${styles.handle} ${styles.handleLive}`}
      role="slider"
      tabIndex={disabled ? -1 : tabIndex}
      aria-label={name}
      aria-valuetext={
        mark === undefined ? valueText : `${valueText}, ${mark ? 'right' : 'not right yet'}`
      }
      aria-valuenow={round(valueNow)}
      aria-valuemin={range[0]}
      aria-valuemax={range[1]}
      aria-orientation={orientation}
      aria-disabled={disabled || undefined}
      data-mark={mark}
      data-handle={handleId}
      onFocus={onFocus}
      onPointerDown={(e) => {
        if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        (e.currentTarget as SVGGElement).focus({ preventScroll: true });
      }}
      onPointerMove={(e) => {
        if (disabled || !e.currentTarget.hasPointerCapture?.(e.pointerId)) return;
        const world = worldAt(e, frame);
        if (world) onDrag(world);
      }}
      onPointerUp={(e) => e.currentTarget.releasePointerCapture?.(e.pointerId)}
      onKeyDown={(e) => {
        if (disabled) return;
        const steps = keySteps(e);
        if (steps && onKey(steps, e)) e.preventDefault();
      }}
    >
      <circle className={styles.handleHit} cx={round(x)} cy={round(y)} r={22} />
      <circle className={styles.handleRing} cx={round(x)} cy={round(y)} r={11} />
      <circle className={styles.handleDot} cx={round(x)} cy={round(y)} r={6.5} />
      {mark === undefined ? null : (
        <text
          className={mark ? styles.handleRight : styles.handleWrong}
          x={round(x + 12)}
          y={round(y + 16)}
        >
          {mark ? '✓' : '✗'}
        </text>
      )}
      {showName ? (
        <text className={styles.handleName} x={round(x + 12)} y={round(y - 12)}>
          {name}
        </text>
      ) : null}
    </g>
  );
}

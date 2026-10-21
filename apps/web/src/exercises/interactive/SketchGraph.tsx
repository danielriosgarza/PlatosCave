import { formatNumber, type InteractiveView } from '@parallax/contracts';
import { type PointerEvent, useEffect, useRef, useState } from 'react';
import type { InteractiveDraft } from './draft';
import { clamp, type Frame, niceStep, polylinePath, smoothPath, type XY } from './geometry';
import { Handle, worldAt } from './Handle';
import styles from './Interactive.module.css';
import { Scene } from './Scene';

type View = Extract<InteractiveView, { kind: 'sketch_graph' }>;
type Draft = Extract<InteractiveDraft, { kind: 'sketch_graph' }>;

/**
 * Sets each sample whose x a stroke from `p` to `q` passes over to the stroke's height there,
 * so drawing across the scene moves the handles under the pen.
 */
export function drawOver(ys: number[], xs: number[], p: XY, q: XY, [lo, hi]: [number, number]) {
  const next = [...ys];
  const [a, b] = p[0] <= q[0] ? [p, q] : [q, p];
  xs.forEach((x, i) => {
    if (x < a[0] || x > b[0]) return;
    const t = b[0] === a[0] ? 1 : (x - a[0]) / (b[0] - a[0]);
    next[i] = clamp(a[1] + (b[1] - a[1]) * t, lo, hi);
  });
  return next;
}

/** Heights as sent: four decimals are finer than any tolerance a sketch is read with. */
const fine = (y: number) => Number(y.toFixed(4));

/**
 * Draw a graph (§9): sweep across the scene with a pointer and the handles at the sample points
 * follow the pen; drag a handle to adjust it; or focus the handles (one tab stop) and use Up and
 * Down to move one, Left and Right to go to its neighbour.
 */
export function SketchGraph({
  view,
  draft,
  disabled,
  parts,
  label,
  onChange,
}: {
  view: View;
  draft: Draft;
  disabled: boolean;
  parts?: Record<string, boolean> | null;
  label: string;
  onChange: (draft: Draft) => void;
}) {
  const [active, setActive] = useState(0);
  const [stroke, setStroke] = useState<XY[] | null>(null);
  const pen = useRef<{ id: number; last: XY } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const range = view.scene.y;
  const step = niceStep(range[1] - range[0], 40);
  // Pointer events can outrun renders: a stroke builds on the heights it last set.
  const latest = useRef(draft.ys);
  latest.current = draft.ys;
  const set = (ys: number[]) => {
    latest.current = ys.map(fine);
    onChange({ kind: 'sketch_graph', ys: latest.current });
  };

  useEffect(() => {
    if (disabled) {
      pen.current = null;
      setStroke(null);
    }
  }, [disabled]);

  const focusHandle = (i: number) => {
    setActive(i);
    box.current?.querySelector<SVGGElement>(`[data-handle="${i}"]`)?.focus();
  };

  const down = (e: PointerEvent<SVGSVGElement>, frame: Frame) => {
    if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const at = worldAt(e, frame);
    if (!at) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pen.current = { id: e.pointerId, last: at };
    setStroke([at]);
    set(drawOver(latest.current, view.xs, at, at, range));
  };
  const move = (e: PointerEvent<SVGSVGElement>, frame: Frame) => {
    const p = pen.current;
    if (!p || p.id !== e.pointerId) return;
    const at = worldAt(e, frame);
    if (!at) return;
    set(drawOver(latest.current, view.xs, p.last, at, range));
    p.last = at;
    setStroke((s) => (s ? [...s, at] : [at]));
  };
  const up = (e: PointerEvent<SVGSVGElement>) => {
    if (pen.current?.id !== e.pointerId) return;
    pen.current = null;
    setStroke(null);
  };

  return (
    <div className={styles.board} ref={box}>
      <p className={styles.empty}>
        Draw across the grid with the pointer, drag the points, or use the arrow keys on them.
      </p>
      <Scene
        scene={view.scene}
        label={label}
        interactive={!disabled}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
      >
        {(frame) => {
          const points = view.xs.map((x, i) => frame.toScreen([x, draft.ys[i] ?? view.start]));
          return (
            <>
              {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: an SVG group is not focusable; the handles carry the curve's values */}
              <g aria-hidden="true">
                <path className={styles.sketchCurve} d={smoothPath(points)} />
                {stroke ? (
                  <path
                    className={styles.sketchStroke}
                    d={polylinePath(stroke.map((p) => frame.toScreen(p)))}
                  />
                ) : null}
              </g>
              {/* biome-ignore lint/a11y/useSemanticElements: SVG has no fieldset */}
              {/* biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: an SVG group that names the handles inside it */}
              <g role="group" aria-label="Points of your curve">
                {view.xs.map((x, i) => {
                  const y = draft.ys[i] ?? view.start;
                  return (
                    <Handle
                      // biome-ignore lint/suspicious/noArrayIndexKey: samples are positional
                      key={i}
                      handleId={String(i)}
                      frame={frame}
                      at={[x, y]}
                      name={`Point at x = ${formatNumber(x)}`}
                      valueText={`y = ${formatNumber(y)}`}
                      valueNow={y}
                      range={range}
                      orientation="vertical"
                      disabled={disabled}
                      mark={parts?.[String(i)]}
                      tabIndex={i === active ? 0 : -1}
                      showName={false}
                      onFocus={() => setActive(i)}
                      onDrag={([, wy]) =>
                        set(draft.ys.map((v, j) => (j === i ? clamp(wy, range[0], range[1]) : v)))
                      }
                      onKey={([dx, dy]) => {
                        if (dx !== 0) {
                          focusHandle(clamp(i + Math.sign(dx), 0, view.xs.length - 1));
                          return true;
                        }
                        set(
                          draft.ys.map((v, j) =>
                            j === i ? clamp(v + dy * step, range[0], range[1]) : v,
                          ),
                        );
                        return true;
                      }}
                    />
                  );
                })}
              </g>
            </>
          );
        }}
      </Scene>
    </div>
  );
}

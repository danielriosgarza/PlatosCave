import { formatNumber, type InteractiveView, snapInside } from '@parallax/contracts';
import { useEffect, useRef, useState } from 'react';
import buttons from '../../components/Buttons.module.css';
import type { InteractiveDraft } from './draft';
import { type Frame, niceStep, PAD, round, ticks, type XY } from './geometry';
import { Handle, worldAt } from './Handle';
import styles from './Interactive.module.css';
import { Glyph } from './icon';
import { Scene } from './Scene';
import { Mark } from './tokens';

type View = Extract<InteractiveView, { kind: 'plot_points' }>;
type Draft = Extract<InteractiveDraft, { kind: 'plot_points' }>;

const coords = (view: View, [x, y]: XY) =>
  view.line ? formatNumber(x) : `(${formatNumber(x)}, ${formatNumber(y)})`;

/**
 * Place points on a plane, or on a number line (§9). An unplaced point waits beside the scene:
 * pick it and click the scene to put it there, or press Enter on it to put it in the middle and
 * move it with the arrow keys. A placed point is dragged or moved with the arrow keys.
 */
export function PlotPoints({
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
  const [picked, setPicked] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focus) return;
    box.current?.querySelector<SVGGElement>(`[data-handle="${CSS.escape(focus)}"]`)?.focus();
    setFocus(null);
  }, [focus]);
  useEffect(() => {
    if (disabled) setPicked(null);
  }, [disabled]);

  const scene = view.line
    ? { ...view.scene, y: [-1, 1] as [number, number], aspect: 6, axes: false, grid: false }
    : view.scene;
  const snap = (p: XY): XY => [
    snapInside(p[0], view.snap, scene.x),
    view.line ? 0 : snapInside(p[1], view.snap, scene.y),
  ];
  const put = (id: string, p: XY) =>
    onChange({ kind: 'plot_points', at: { ...draft.at, [id]: snap(p) } });
  const middle: XY = [(scene.x[0] + scene.x[1]) / 2, view.line ? 0 : (scene.y[0] + scene.y[1]) / 2];
  const waiting = view.points.filter((p) => !draft.at[p.id]);

  return (
    <div className={styles.board} ref={box}>
      <Scene
        scene={scene}
        label={label}
        interactive={!disabled}
        onPointerDown={(e, frame) => {
          if (!picked || disabled) return;
          const world = worldAt(e, frame);
          if (world) put(picked, world);
          setFocus(picked);
          setPicked(null);
        }}
      >
        {(frame) => (
          <>
            {view.line ? (
              <NumberLine
                frame={frame}
                step={view.scene.ticks ?? niceStep(frame.x[1] - frame.x[0])}
              />
            ) : null}
            {view.points.map((p) => {
              const at = draft.at[p.id];
              if (!at) return null;
              return (
                <Handle
                  key={p.id}
                  handleId={p.id}
                  frame={frame}
                  at={at}
                  name={p.label}
                  valueText={`${p.label} at ${coords(view, at)}`}
                  valueNow={at[0]}
                  range={scene.x}
                  orientation={view.line ? 'horizontal' : undefined}
                  disabled={disabled}
                  mark={parts?.[p.id]}
                  icon={p.icon}
                  onDrag={(world) => put(p.id, world)}
                  onKey={([dx, dy]) => {
                    if (view.line && dy !== 0) return false;
                    put(p.id, [at[0] + dx * view.snap, at[1] + dy * view.snap]);
                    return true;
                  }}
                />
              );
            })}
          </>
        )}
      </Scene>
      {waiting.length ? (
        <section className={styles.bank} aria-label="Points to place">
          <ul className={styles.tokens}>
            {waiting.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className={`${styles.token} ${styles.pointToken}`}
                  aria-pressed={picked === p.id}
                  disabled={disabled}
                  onClick={(e) => {
                    // A keyboard press places the point at once; a click picks it for the scene.
                    if (e.detail === 0) {
                      put(p.id, middle);
                      setFocus(p.id);
                      return;
                    }
                    setPicked(picked === p.id ? null : p.id);
                  }}
                >
                  {p.icon ? (
                    <Glyph name={p.icon} size={20} />
                  ) : (
                    <span className={styles.pointDot} aria-hidden="true" />
                  )}
                  {p.label}
                </button>
              </li>
            ))}
          </ul>
          <p className={styles.empty}>
            {picked
              ? `Click the ${view.line ? 'number line' : 'grid'} where ${view.points.find((p) => p.id === picked)?.label ?? 'the point'} goes.`
              : 'Click a point, then the place it goes; or press Enter on it and use the arrow keys.'}
          </p>
        </section>
      ) : null}
      <ul className={styles.readout} aria-label="Placed points">
        {view.points
          .filter((p) => draft.at[p.id])
          .map((p) => (
            <li key={p.id}>
              {`${p.label}: ${coords(view, draft.at[p.id] as XY)}`}
              {parts?.[p.id] === undefined ? null : <Mark right={parts[p.id] as boolean} />}
            </li>
          ))}
      </ul>
      {!disabled && view.points.some((p) => draft.at[p.id] && !p.start) ? (
        <button
          type="button"
          className={buttons.textButton}
          onClick={() =>
            onChange({
              kind: 'plot_points',
              at: Object.fromEntries(
                view.points.flatMap((p) => (p.start ? [[p.id, p.start] as const] : [])),
              ),
            })
          }
        >
          Take the points back
        </button>
      ) : null}
    </div>
  );
}

function NumberLine({ frame, step }: { frame: Frame; step: number }) {
  const [, y] = frame.toScreen([0, 0]);
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: an SVG group is not focusable; positions are read from the handles
    <g aria-hidden="true">
      <line className={styles.axis} x1={PAD} x2={frame.width - PAD} y1={y} y2={y} />
      {ticks(frame.x[0], frame.x[1], step).map((v) => {
        const [x] = frame.toScreen([v, 0]);
        return (
          <g key={v}>
            <line className={styles.axis} x1={round(x)} x2={round(x)} y1={y - 6} y2={y + 6} />
            <text className={styles.tick} x={round(x)} y={y + 22} textAnchor="middle">
              {formatNumber(v)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

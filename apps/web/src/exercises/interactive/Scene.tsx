import {
  type ExpressionScope,
  interpolate,
  MAX_REPEAT,
  type Quantity,
  quantityValue,
  type Scene as SceneData,
  type SceneShape,
} from '@parallax/contracts';
import {
  type PointerEvent,
  type ReactNode,
  type Ref,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  clipLine,
  type Frame,
  frameFor,
  niceStep,
  PAD,
  polylinePath,
  round,
  ticks,
  type XY,
} from './geometry';
import styles from './Interactive.module.css';

/** Samples per function graph or curve: smooth at the widest scene, cheap to redraw per frame. */
const SAMPLES = 240;
/** Width assumed before the container is measured, and where it cannot be (tests). */
const FALLBACK_WIDTH = 600;

/** The width of a container, kept current as it resizes. */
export function useWidth<T extends HTMLElement>(): [Ref<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

const value = (q: Quantity, scope: ExpressionScope) => quantityValue(q, scope);
const at = (p: readonly [Quantity, Quantity], scope: ExpressionScope): XY => [
  value(p[0], scope),
  value(p[1], scope),
];
const finite = (...ns: number[]) => ns.every(Number.isFinite);

interface Props {
  scene: SceneData;
  /** Values of the step's parameters, by expression name. */
  scope?: ExpressionScope;
  /** Names the drawing for a screen reader when the scene has no description. */
  label: string;
  /** Takes pointer input: touch does not scroll the page while it is over the drawing. */
  interactive?: boolean;
  /** SVG drawn above the shapes, in the scene's frame: handles, regions, marks. */
  children?: (frame: Frame) => ReactNode;
  /** HTML laid over the drawing, in the scene's frame: drop targets. */
  overlay?: (frame: Frame) => ReactNode;
  svgRef?: Ref<SVGSVGElement>;
  /** Pointer input on the drawing, with the frame it is drawn in. */
  onPointerDown?: (e: PointerEvent<SVGSVGElement>, frame: Frame) => void;
  onPointerMove?: (e: PointerEvent<SVGSVGElement>, frame: Frame) => void;
  onPointerUp?: (e: PointerEvent<SVGSVGElement>, frame: Frame) => void;
}

/**
 * A scene (`packages/contracts/src/scene.ts`) drawn as SVG at the width of its container. Every
 * shape is React-rendered from data, so an author's text is only ever text. Static shapes are
 * hidden from assistive technology: the scene's description stands for them, and interactive
 * pieces drawn by `children` carry their own names.
 */
export function Scene({
  scene,
  scope = {},
  label,
  interactive,
  children,
  overlay,
  svgRef,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: Props) {
  const [box, available] = useWidth<HTMLDivElement>();
  const frame = frameFor(scene, available);
  const clip = `scene-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const description = scene.description ?? label;
  return (
    <figure className={styles.figure}>
      <div ref={box} className={styles.sceneBox}>
        <div className={styles.sceneHolder} style={{ width: frame.width }}>
          {/* biome-ignore lint/a11y/useSemanticElements: an SVG drawing that groups the controls drawn in it */}
          <svg
            ref={svgRef}
            className={interactive ? `${styles.scene} ${styles.sceneLive}` : styles.scene}
            viewBox={`0 0 ${round(frame.width)} ${round(frame.height)}`}
            width={round(frame.width)}
            height={round(frame.height)}
            role="group"
            aria-label={description}
            onPointerDown={onPointerDown && ((e) => onPointerDown(e, frame))}
            onPointerMove={onPointerMove && ((e) => onPointerMove(e, frame))}
            onPointerUp={onPointerUp && ((e) => onPointerUp(e, frame))}
            onPointerCancel={onPointerUp && ((e) => onPointerUp(e, frame))}
          >
            <defs>
              <clipPath id={clip}>
                <rect
                  x={PAD}
                  y={PAD}
                  width={round(frame.width - 2 * PAD)}
                  height={round(frame.height - 2 * PAD)}
                />
              </clipPath>
            </defs>
            {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: an SVG group is not focusable; the description stands for the drawing */}
            <g aria-hidden="true">
              <Axes scene={scene} frame={frame} />
              <g clipPath={`url(#${clip})`}>
                {scene.shapes.map((shape, i) => (
                  // Shapes are positional data with no identity of their own.
                  // biome-ignore lint/suspicious/noArrayIndexKey: see above
                  <Repeated key={i} shape={shape} scope={scope} frame={frame} />
                ))}
              </g>
              {scene.shapes.map((shape, i) =>
                shape.type === 'text' ||
                ((shape.type === 'point' || shape.type === 'segment') && shape.label) ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: labels follow their shapes
                  <Labels key={i} shape={shape} scope={scope} frame={frame} />
                ) : null,
              )}
            </g>
            {children?.(frame)}
          </svg>
          {overlay ? <div className={styles.overlay}>{overlay(frame)}</div> : null}
        </div>
      </div>
    </figure>
  );
}

function Axes({ scene, frame }: { scene: SceneData; frame: Frame }) {
  const [x0, x1] = frame.x;
  const [y0, y1] = frame.y;
  const xStep = scene.ticks ?? niceStep(x1 - x0);
  const yStep =
    scene.ticks ?? niceStep(y1 - y0, Math.max(3, Math.round(8 / (frame.width / frame.height))));
  const gridStep = typeof scene.grid === 'number' ? scene.grid : null;
  const lines: ReactNode[] = [];
  if (scene.grid) {
    const gx = ticks(x0, x1, gridStep ?? xStep);
    const gy = ticks(y0, y1, gridStep ?? yStep);
    for (const x of gx) {
      const [sx] = frame.toScreen([x, 0]);
      lines.push(
        <line
          key={`gx${x}`}
          className={styles.grid}
          x1={sx}
          x2={sx}
          y1={PAD}
          y2={frame.height - PAD}
        />,
      );
    }
    for (const y of gy) {
      const [, sy] = frame.toScreen([0, y]);
      lines.push(
        <line
          key={`gy${y}`}
          className={styles.grid}
          x1={PAD}
          x2={frame.width - PAD}
          y1={sy}
          y2={sy}
        />,
      );
    }
  }
  if (!scene.axes) return <g>{lines}</g>;
  const names = typeof scene.axes === 'object' ? scene.axes : {};
  // The axes cross at 0, or at the edge nearest to it when 0 is outside a range.
  const ox = Math.min(x1, Math.max(x0, 0));
  const oy = Math.min(y1, Math.max(y0, 0));
  const [sx0, sy] = frame.toScreen([x0, oy]);
  const [sx1] = frame.toScreen([x1, oy]);
  const [sx, sy0] = frame.toScreen([ox, y0]);
  const [, sy1] = frame.toScreen([ox, y1]);
  const near = (v: number, step: number) => Math.abs(v) < step / 1000;
  return (
    <g>
      {lines}
      <line className={styles.axis} x1={sx0} x2={sx1} y1={sy} y2={sy} />
      <line className={styles.axis} x1={sx} x2={sx} y1={sy0} y2={sy1} />
      {ticks(x0, x1, xStep).map((x) => {
        const [tx] = frame.toScreen([x, oy]);
        return (
          <g key={`tx${x}`}>
            <line className={styles.axis} x1={tx} x2={tx} y1={sy - 3} y2={sy + 3} />
            {near(x - ox, xStep) && ox !== x0 ? null : (
              <text className={styles.tick} x={tx} y={sy + 16} textAnchor="middle">
                {x}
              </text>
            )}
          </g>
        );
      })}
      {ticks(y0, y1, yStep).map((y) => {
        const [, ty] = frame.toScreen([ox, y]);
        return (
          <g key={`ty${y}`}>
            <line className={styles.axis} x1={sx - 3} x2={sx + 3} y1={ty} y2={ty} />
            {near(y - oy, yStep) ? null : (
              <text className={styles.tick} x={sx - 6} y={ty + 4} textAnchor="end">
                {y}
              </text>
            )}
          </g>
        );
      })}
      {names.x ? (
        <text className={styles.axisName} x={sx1} y={sy - 8} textAnchor="end">
          {names.x}
        </text>
      ) : null}
      {names.y ? (
        <text className={styles.axisName} x={sx + 8} y={sy1 + 12} textAnchor="start">
          {names.y}
        </text>
      ) : null}
    </g>
  );
}

/** The copies of a shape that `each` asks for, and only while `show` holds. */
function copies(shape: SceneShape, scope: ExpressionScope): ExpressionScope[] {
  const one = (s: ExpressionScope) =>
    shape.show ? value(shape.show, s) !== 0 && !Number.isNaN(value(shape.show, s)) : true;
  if (!shape.each) return one(scope) ? [scope] : [];
  const count = Math.min(MAX_REPEAT, Math.max(0, Math.floor(value(shape.each.count, scope))));
  const name = shape.each.name;
  const out: ExpressionScope[] = [];
  for (let i = 0; i < (Number.isFinite(count) ? count : 0); i++) {
    const s = { ...scope, [name]: i };
    if (one(s)) out.push(s);
  }
  return out;
}

const STROKE = {
  ink: styles.inkStroke,
  muted: styles.mutedStroke,
  faint: styles.faintStroke,
} as const;
const FILL = {
  none: styles.noFill,
  soft: styles.softFill,
  muted: styles.mutedFill,
  ink: styles.inkFill,
} as const;
const WEIGHT = { thin: 1, normal: 2, thick: 3.5 } as const;

/** Stroke and fill classes for a shape; `open` shapes (lines, graphs, unclosed paths) never fill. */
function look(shape: SceneShape, filled: boolean, open = false) {
  const fill = open
    ? styles.noFill
    : 'fill' in shape && shape.fill
      ? FILL[shape.fill]
      : filled
        ? styles.toneFill
        : styles.noFill;
  return {
    className: `${STROKE[shape.tone ?? 'ink']} ${fill}`,
    strokeWidth: WEIGHT[shape.weight ?? 'normal'],
    strokeDasharray: shape.dash ? '6 5' : undefined,
  };
}

function Repeated({
  shape,
  scope,
  frame,
}: {
  shape: SceneShape;
  scope: ExpressionScope;
  frame: Frame;
}) {
  return (
    <>
      {copies(shape, scope).map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: copies are numbered by their counter
        <ShapeView key={i} shape={shape} scope={s} frame={frame} />
      ))}
    </>
  );
}

const POINT_RADIUS = { small: 3, normal: 4.5, large: 6.5 } as const;

function ShapeView({
  shape,
  scope,
  frame,
}: {
  shape: SceneShape;
  scope: ExpressionScope;
  frame: Frame;
}): ReactNode {
  const screen = (p: readonly [Quantity, Quantity]) => frame.toScreen(at(p, scope));
  switch (shape.type) {
    case 'point': {
      const [x, y] = screen(shape.at);
      if (!finite(x, y)) return null;
      return (
        <circle
          cx={round(x)}
          cy={round(y)}
          r={POINT_RADIUS[shape.size ?? 'normal']}
          {...look(shape, true)}
        />
      );
    }
    case 'segment': {
      const a = screen(shape.from);
      const b = screen(shape.to);
      if (!finite(...a, ...b)) return null;
      const style = look(shape, false);
      return (
        <g>
          <line x1={round(a[0])} y1={round(a[1])} x2={round(b[0])} y2={round(b[1])} {...style} />
          {shape.arrow === 'end' || shape.arrow === 'both' ? (
            <Arrowhead from={a} to={b} className={style.className} />
          ) : null}
          {shape.arrow === 'both' ? (
            <Arrowhead from={b} to={a} className={style.className} />
          ) : null}
        </g>
      );
    }
    case 'line': {
      const ends = clipLine(
        at(shape.through[0], scope),
        at(shape.through[1], scope),
        frame.x,
        frame.y,
      );
      if (!ends) return null;
      const [a, b] = ends.map((p) => frame.toScreen(p));
      if (!a || !b || !finite(...a, ...b)) return null;
      return (
        <line
          x1={round(a[0])}
          y1={round(a[1])}
          x2={round(b[0])}
          y2={round(b[1])}
          {...look(shape, false)}
        />
      );
    }
    case 'polygon': {
      const points = shape.points.map((p) => screen(p));
      if (!points.every((p) => finite(...p))) return null;
      const list = points.map(([x, y]) => `${round(x)},${round(y)}`).join(' ');
      return shape.closed === false ? (
        <polyline points={list} {...look(shape, false, true)} />
      ) : (
        <polygon points={list} {...look(shape, false)} />
      );
    }
    case 'circle': {
      const [cx, cy] = screen(shape.center);
      const r = value(shape.r, scope);
      if (!finite(cx, cy, r) || r <= 0) return null;
      return (
        <ellipse
          cx={round(cx)}
          cy={round(cy)}
          rx={round(r * frame.kx)}
          ry={round(r * frame.ky)}
          {...look(shape, false)}
        />
      );
    }
    case 'rect': {
      const [x, y] = at(shape.at, scope);
      const [w, h] = at(shape.size, scope);
      if (!finite(x, y, w, h)) return null;
      const [sx, sy] = frame.toScreen([Math.min(x, x + w), Math.max(y, y + h)]);
      return (
        <rect
          x={round(sx)}
          y={round(sy)}
          width={round(Math.abs(w) * frame.kx)}
          height={round(Math.abs(h) * frame.ky)}
          {...look(shape, false)}
        />
      );
    }
    case 'arc': {
      const [cx, cy] = at(shape.center, scope);
      const r = value(shape.r, scope);
      const from = value(shape.from, scope);
      const to = value(shape.to, scope);
      if (!finite(cx, cy, r, from, to) || r <= 0) return null;
      const n = Math.max(2, Math.ceil(Math.abs(to - from) / 3));
      const points: XY[] = Array.from({ length: n + 1 }, (_, i) => {
        const a = ((from + ((to - from) * i) / n) * Math.PI) / 180;
        return frame.toScreen([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      });
      if (shape.sector) points.unshift(frame.toScreen([cx, cy]));
      const d = polylinePath(points) + (shape.sector ? 'Z' : '');
      return <path d={d} {...look(shape, false, !shape.sector && !shape.fill)} />;
    }
    case 'function': {
      const [lo, hi] = shape.domain ? at(shape.domain, scope) : frame.x;
      if (!finite(lo, hi) || hi <= lo) return null;
      const points = Array.from({ length: SAMPLES + 1 }, (_, i) => {
        const x = lo + ((hi - lo) * i) / SAMPLES;
        const y = value(shape.y, { ...scope, x });
        return Number.isFinite(y) ? frame.toScreen([x, y]) : null;
      });
      return <path d={polylinePath(points, frame.height * 2)} {...look(shape, false, true)} />;
    }
    case 'curve': {
      const [lo, hi] = at(shape.t, scope);
      if (!finite(lo, hi)) return null;
      const points = Array.from({ length: SAMPLES + 1 }, (_, i) => {
        const t = lo + ((hi - lo) * i) / SAMPLES;
        const p: XY = [value(shape.x, { ...scope, t }), value(shape.y, { ...scope, t })];
        return finite(...p) ? frame.toScreen(p) : null;
      });
      return <path d={polylinePath(points, frame.height * 2)} {...look(shape, false, true)} />;
    }
    case 'text':
      return null;
  }
}

function Arrowhead({ from, to, className }: { from: XY; to: XY; className: string }) {
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const size = 9;
  const wing = (turn: number): XY => [
    to[0] - size * Math.cos(angle + turn),
    to[1] - size * Math.sin(angle + turn),
  ];
  const [a, b] = [wing(0.45), wing(-0.45)];
  return (
    <polygon
      className={`${className} ${styles.headFill}`}
      points={`${round(to[0])},${round(to[1])} ${round(a[0])},${round(a[1])} ${round(b[0])},${round(b[1])}`}
    />
  );
}

/** A shape's label, or a text shape, drawn outside the clip so it is never cut at the edge. */
function Labels({
  shape,
  scope,
  frame,
}: {
  shape: SceneShape;
  scope: ExpressionScope;
  frame: Frame;
}) {
  return (
    <>
      {copies(shape, scope).map((s, i) => {
        const placed = labelPlace(shape, s, frame);
        if (!placed) return null;
        const [x, y, text, anchor, size] = placed;
        return (
          <text
            // biome-ignore lint/suspicious/noArrayIndexKey: copies are numbered by their counter
            key={i}
            className={`${styles.label} ${size === 'large' ? styles.labelLarge : size === 'small' ? styles.labelSmall : ''}`}
            x={round(x)}
            y={round(y)}
            textAnchor={anchor}
          >
            {text}
          </text>
        );
      })}
    </>
  );
}

function labelPlace(
  shape: SceneShape,
  scope: ExpressionScope,
  frame: Frame,
): [number, number, string, 'start' | 'middle' | 'end', string | undefined] | null {
  if (shape.type === 'text') {
    const [x, y] = frame.toScreen(at(shape.at, scope));
    if (!finite(x, y)) return null;
    return [x, y + 5, interpolate(shape.text, scope), shape.align ?? 'middle', shape.size];
  }
  if (shape.type === 'point' && shape.label) {
    const [x, y] = frame.toScreen(at(shape.at, scope));
    if (!finite(x, y)) return null;
    return [x + 8, y - 8, interpolate(shape.label, scope), 'start', undefined];
  }
  if (shape.type === 'segment' && shape.label) {
    const a = frame.toScreen(at(shape.from, scope));
    const b = frame.toScreen(at(shape.to, scope));
    if (!finite(...a, ...b)) return null;
    return [
      (a[0] + b[0]) / 2 + 6,
      (a[1] + b[1]) / 2 - 6,
      interpolate(shape.label, scope),
      'start',
      undefined,
    ];
  }
  return null;
}

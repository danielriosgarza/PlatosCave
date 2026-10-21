import type { Scene } from '@parallax/contracts';

/**
 * World-to-screen geometry of a scene (§9): the frame a scene is drawn in, its axis ticks, and
 * the paths of curves. World y points up; screen y points down. The plot area is inset by `PAD`
 * so tick labels and point labels stay inside the drawing.
 */

export type XY = [number, number];

export const PAD = 28;
/** The widest a scene is drawn, and the tallest, in CSS pixels. */
export const MAX_WIDTH = 680;
export const MAX_HEIGHT = 520;

export interface Frame {
  width: number;
  height: number;
  /** World x and y ranges. */
  x: [number, number];
  y: [number, number];
  toScreen: (p: readonly [number, number]) => XY;
  /** Pixels per world unit along each axis. */
  kx: number;
  ky: number;
}

/** Width over height of the plot area: the scene's `aspect`, else equal units within 1:2 to 2.5:1. */
export function aspectOf(scene: Pick<Scene, 'x' | 'y' | 'aspect'>): number {
  if (scene.aspect) return scene.aspect;
  const ratio = (scene.x[1] - scene.x[0]) / (scene.y[1] - scene.y[0]);
  return Math.min(2.5, Math.max(0.5, ratio));
}

/** The frame for a scene drawn in a container `available` pixels wide. */
export function frameFor(scene: Pick<Scene, 'x' | 'y' | 'aspect'>, available: number): Frame {
  const aspect = aspectOf(scene);
  const inner = Math.max(
    120,
    Math.min(available, MAX_WIDTH, (MAX_HEIGHT - 2 * PAD) * aspect + 2 * PAD) - 2 * PAD,
  );
  const width = inner + 2 * PAD;
  const height = inner / aspect + 2 * PAD;
  const [x0, x1] = scene.x;
  const [y0, y1] = scene.y;
  const kx = inner / (x1 - x0);
  const ky = (height - 2 * PAD) / (y1 - y0);
  return {
    width,
    height,
    x: [x0, x1],
    y: [y0, y1],
    kx,
    ky,
    toScreen: ([x, y]) => [PAD + (x - x0) * kx, PAD + (y1 - y) * ky],
  };
}

/** A screen position in a frame as world coordinates. */
export const toWorld = (frame: Frame, [sx, sy]: XY): XY => [
  frame.x[0] + (sx - PAD) / frame.kx,
  frame.y[1] - (sy - PAD) / frame.ky,
];

export { niceStep } from '@parallax/contracts';

/** The multiples of `step` in [lo, hi], snapped so that 0.1 + 0.2 reads as 0.3. */
export function ticks(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  const first = Math.ceil(lo / step - 1e-9);
  for (let k = first; k * step <= hi + 1e-9 && out.length < 400; k++) {
    out.push(Number((k * step).toFixed(10)));
  }
  return out;
}

/**
 * An SVG path through `points` in screen coordinates, broken where a point is missing (null) or
 * jumps further than `gap` pixels vertically, so an asymptote is not joined across.
 */
export function polylinePath(points: (XY | null)[], gap = Number.POSITIVE_INFINITY): string {
  let d = '';
  let open = false;
  let last: XY | null = null;
  for (const p of points) {
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      open = false;
      last = null;
      continue;
    }
    const jump = last !== null && Math.abs(p[1] - last[1]) > gap;
    d += `${open && !jump ? 'L' : 'M'}${round(p[0])} ${round(p[1])}`;
    open = true;
    last = p;
  }
  return d;
}

/** A smooth path through `points` (Catmull–Rom as cubic Béziers), for a sketched curve. */
export function smoothPath(points: XY[]): string {
  if (points.length === 0) return '';
  const first = points[0] as XY;
  let d = `M${round(first[0])} ${round(first[1])}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i] as XY;
    const p2 = points[i + 1] as XY;
    const p3 = points[i + 2] ?? p2;
    const c1: XY = [p1[0] + (p2[0] - (p0 as XY)[0]) / 6, p1[1] + (p2[1] - (p0 as XY)[1]) / 6];
    const c2: XY = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${round(c1[0])} ${round(c1[1])} ${round(c2[0])} ${round(c2[1])} ${round(p2[0])} ${round(p2[1])}`;
  }
  return d;
}

/**
 * The part of the line through `a` and `b` inside the box [x0, x1] × [y0, y1] (world units),
 * or null when it misses the box or the two points coincide.
 */
export function clipLine(
  a: XY,
  b: XY,
  [x0, x1]: [number, number],
  [y0, y1]: [number, number],
): [XY, XY] | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return null;
  let lo = Number.NEGATIVE_INFINITY;
  let hi = Number.POSITIVE_INFINITY;
  const edges: [number, number][] = [
    [-dx, a[0] - x0],
    [dx, x1 - a[0]],
    [-dy, a[1] - y0],
    [dy, y1 - a[1]],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) lo = Math.max(lo, t);
    else hi = Math.min(hi, t);
  }
  if (lo > hi) return null;
  return [
    [a[0] + lo * dx, a[1] + lo * dy],
    [a[0] + hi * dx, a[1] + hi * dy],
  ];
}

/** Whether a world point lies inside a polygon (even–odd rule). */
export function insidePolygon([x, y]: XY, polygon: readonly XY[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i] as XY;
    const [xj, yj] = polygon[j] as XY;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export const round = (n: number) => Math.round(n * 100) / 100;

/** `v` within [lo, hi]. */
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

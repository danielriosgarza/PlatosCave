import { SKETCH_REFERENCE_WIDTH, type Strokes } from '@parallax/contracts';

export type Stroke = Strokes[number];

/** The strokes on the surface, and those taken back by Undo that Redo can bring back. */
export interface History {
  strokes: Strokes;
  undone: Strokes;
}

export const emptyHistory = (strokes: Strokes = []): History => ({ strokes, undone: [] });

/** The contract keeps at most this many strokes, and points per stroke (anchors.ts). */
export const MAX_STROKES = 500;
export const MAX_POINTS = 2000;

/** A new stroke is a new branch: whatever was undone can no longer be redone. */
export const push = (h: History, stroke: Stroke): History =>
  h.strokes.length >= MAX_STROKES ? h : { strokes: [...h.strokes, stroke], undone: [] };

export function undo(h: History): History {
  const last = h.strokes[h.strokes.length - 1];
  return last ? { strokes: h.strokes.slice(0, -1), undone: [...h.undone, last] } : h;
}

export function redo(h: History): History {
  const last = h.undone[h.undone.length - 1];
  return last ? { strokes: [...h.strokes, last], undone: h.undone.slice(0, -1) } : h;
}

const unit = (n: number) => Math.min(1, Math.max(0, n));
const round = (n: number) => Math.round(n * 10_000) / 10_000;

/** A pointer position as a share of the surface; null while the surface has no size. */
export function normalise(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): [number, number] | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return [
    round(unit((clientX - rect.left) / rect.width)),
    round(unit((clientY - rect.top) / rect.height)),
  ];
}

/**
 * A stroke's points as stored: neighbours closer than a tenth of a percent of the surface are
 * dropped, and a very long stroke is thinned evenly to the contract's limit, keeping its ends.
 */
export function thin(points: [number, number][]): [number, number][] {
  const kept: [number, number][] = [];
  for (const p of points) {
    const prev = kept[kept.length - 1];
    if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) >= 0.001) kept.push(p);
  }
  const last = points[points.length - 1];
  if (last && kept[kept.length - 1] !== last && kept.length > 1) kept.push(last);
  if (kept.length <= MAX_POINTS) return kept.length ? kept : points.slice(0, 1);
  const step = (kept.length - 1) / (MAX_POINTS - 1);
  return Array.from(
    { length: MAX_POINTS },
    (_, i) => kept[Math.round(i * step)] as [number, number],
  );
}

/** The smallest normalised rectangle holding the drawing, for a PDF anchor. */
export function bounds(strokes: Strokes): { x: number; y: number; w: number; h: number } {
  const points = strokes.flatMap((s) => s.points);
  if (points.length === 0) return { x: 0, y: 0, w: 1, h: 1 };
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: round(Math.max(...xs) - x), h: round(Math.max(...ys) - y) };
}

/** Paints strokes onto a canvas of `width` × `height` device pixels; erasers cut what is under them. */
export function paint(
  ctx: CanvasRenderingContext2D,
  strokes: Strokes,
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of strokes) {
    ctx.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    const size = (stroke.width * width) / SKETCH_REFERENCE_WIDTH;
    ctx.lineWidth = size;
    const [first, ...rest] = stroke.points;
    if (!first) continue;
    if (rest.length === 0) {
      ctx.beginPath();
      ctx.arc(first[0] * width, first[1] * height, size / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(first[0] * width, first[1] * height);
    for (const p of rest) ctx.lineTo(p[0] * width, p[1] * height);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

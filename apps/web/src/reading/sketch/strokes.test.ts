import { describe, expect, it } from 'vitest';
import { bounds, emptyHistory, MAX_POINTS, normalise, push, redo, thin, undo } from './strokes';

const stroke = (x: number) => ({
  tool: 'pen' as const,
  color: '#202124',
  width: 3,
  points: [[x, 0.5]] as [number, number][],
});

describe('sketch history', () => {
  it('A07 undo takes the last stroke back, redo returns it, and a new stroke ends the redo branch', () => {
    let h = emptyHistory();
    h = push(push(push(h, stroke(0.1)), stroke(0.2)), stroke(0.3));
    h = undo(undo(h));
    expect(h.strokes.map((s) => s.points[0]?.[0])).toEqual([0.1]);
    h = redo(h);
    expect(h.strokes.map((s) => s.points[0]?.[0])).toEqual([0.1, 0.2]);
    h = push(undo(h), stroke(0.9));
    expect(h.undone).toEqual([]);
    expect(redo(h)).toBe(h);
    expect(undo(emptyHistory())).toEqual(emptyHistory());
  });
});

describe('sketch geometry', () => {
  it('A07 normalises to the surface, so the same drawing lands the same at any zoom', () => {
    const small = { left: 10, top: 20, width: 200, height: 100 };
    const large = { left: 0, top: 0, width: 800, height: 400 };
    expect(normalise(110, 70, small)).toEqual([0.5, 0.5]);
    expect(normalise(400, 200, large)).toEqual([0.5, 0.5]);
    // Outside the surface is held at its edge; a surface without size takes no ink.
    expect(normalise(-50, 500, small)).toEqual([0, 1]);
    expect(normalise(5, 5, { left: 0, top: 0, width: 0, height: 0 })).toBeNull();
  });

  it('A07 thins a long stroke to the contract limit and keeps both ends', () => {
    const points = Array.from({ length: 5000 }, (_, i) => [i / 5000, 0.5] as [number, number]);
    const thinned = thin(points);
    expect(thinned.length).toBeLessThanOrEqual(MAX_POINTS);
    expect(thinned[0]).toEqual(points[0]);
    expect(thinned[thinned.length - 1]).toEqual(points[4999]);
    // A tap stays one point.
    expect(thin([[0.4, 0.4]])).toEqual([[0.4, 0.4]]);
    expect(
      thin([
        [0.4, 0.4],
        [0.4, 0.4],
      ]),
    ).toEqual([[0.4, 0.4]]);
  });

  it('A07 bounds the drawing for a PDF anchor', () => {
    expect(bounds([])).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(
      bounds([
        {
          tool: 'pen',
          color: '#202124',
          width: 3,
          points: [
            [0.2, 0.3],
            [0.6, 0.9],
          ],
        },
      ]),
    ).toEqual({ x: 0.2, y: 0.3, w: 0.4, h: 0.6 });
  });
});

import { useEffect, useRef, useState } from 'react';

/**
 * Motion in interactive steps (§9): a parameter played over time, and a revealed answer moved
 * into place. Both are content the learner asked for; with reduced motion a revealed answer
 * appears at once, and nothing ever starts playing by itself (DESIGN.md, Elevation & Depth).
 */

const query = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.(query).matches === true;
}

/** Whether the person asked for reduced motion, kept current. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const change = () => setReduced(list.matches);
    list.addEventListener?.('change', change);
    return () => list.removeEventListener?.('change', change);
  }, []);
  return reduced;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * Calls `frame` with progress from 0 to 1 over `ms`, eased, then once more with 1. Returns a
 * cancel function. Without animation frames, or with reduced motion, it calls `frame(1)` at once.
 */
export function tween(ms: number, frame: (t: number) => void): () => void {
  if (prefersReducedMotion() || typeof requestAnimationFrame !== 'function') {
    frame(1);
    return () => {};
  }
  let id = 0;
  let start: number | null = null;
  const tick = (now: number) => {
    start ??= now;
    const t = Math.min(1, (now - start) / ms);
    frame(ease(t));
    if (t < 1) id = requestAnimationFrame(tick);
  };
  id = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(id);
}

/** Linear interpolation between numbers, and between [x, y] pairs. */
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
export const mixPair = (a: [number, number], b: [number, number], t: number): [number, number] => [
  mix(a[0], b[0], t),
  mix(a[1], b[1], t),
];

/**
 * Runs `onFrame(elapsedSeconds)` on every animation frame while `playing`, from the moment it
 * started; stops when `playing` turns false or the component unmounts.
 */
export function useFrames(playing: boolean, onFrame: (seconds: number) => void) {
  const callback = useRef(onFrame);
  callback.current = onFrame;
  useEffect(() => {
    if (!playing || typeof requestAnimationFrame !== 'function') return;
    let id = 0;
    let start: number | null = null;
    const tick = (now: number) => {
      start ??= now;
      callback.current((now - start) / 1000);
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing]);
}

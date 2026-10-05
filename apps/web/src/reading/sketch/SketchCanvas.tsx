import type { Strokes } from '@parallax/contracts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import styles from './Sketch.module.css';
import { normalise, paint, type Stroke, thin } from './strokes';
import { ERASER_WIDTH, type Tool } from './useSketches';

export interface Pen {
  tool: Tool;
  color: string;
  width: number;
  onStroke: (stroke: Stroke) => void;
}

interface Props {
  strokes: Strokes;
  /** Present while the reader is drawing: only then does the canvas take pointer input. */
  pen?: Pen | null;
  label: string;
  /** Reports the drawn size, so an export knows the surface's proportions. */
  onSize?: (width: number, height: number) => void;
}

/**
 * Freehand ink over a figure or page, filling its positioned parent. Points are stored as shares
 * of the canvas, so the drawing follows zoom, reflow and Focus. `touch-action: none` is set only
 * while `pen` is given: otherwise touch scrolls the page as usual (§8).
 */
export function SketchCanvas({ strokes, pen, label, onSize }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const live = useRef<{ id: number; stroke: Stroke } | null>(null);
  const [, repaint] = useState(0);

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      setSize((old) =>
        old.width === rect.width && old.height === rect.height
          ? old
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (size.width > 0) onSize?.(size.width, size.height);
  }, [size, onSize]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `repaint` counts the live stroke's points
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || size.width === 0) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.width * ratio);
    canvas.height = Math.round(size.height * ratio);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    paint(
      ctx,
      live.current ? [...strokes, live.current.stroke] : strokes,
      canvas.width,
      canvas.height,
    );
  });

  const point = (e: React.PointerEvent<HTMLCanvasElement>) =>
    normalise(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());

  const handlers = pen
    ? {
        onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          const at = point(e);
          if (!at) return;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          live.current = {
            id: e.pointerId,
            stroke: {
              tool: pen.tool,
              color: pen.tool === 'eraser' ? '#ffffff' : pen.color,
              width: pen.tool === 'eraser' ? ERASER_WIDTH : pen.width,
              points: [at],
            },
          };
          repaint((n) => n + 1);
        },
        onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => {
          const now = live.current;
          const at = point(e);
          if (!now || now.id !== e.pointerId || !at) return;
          now.stroke = { ...now.stroke, points: [...now.stroke.points, at] };
          repaint((n) => n + 1);
        },
        onPointerUp: (e: React.PointerEvent<HTMLCanvasElement>) => {
          const now = live.current;
          if (!now || now.id !== e.pointerId) return;
          live.current = null;
          pen.onStroke({ ...now.stroke, points: thin(now.stroke.points) });
        },
        onPointerCancel: () => {
          live.current = null;
          repaint((n) => n + 1);
        },
        onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
      }
    : {};

  return (
    <canvas
      ref={ref}
      className={pen ? `${styles.canvas} ${styles.drawing}` : styles.canvas}
      style={pen ? { touchAction: 'none', pointerEvents: 'auto' } : undefined}
      role={pen ? 'img' : undefined}
      aria-label={pen ? `Freehand sketch on ${label}. A text description follows.` : undefined}
      aria-hidden={pen ? undefined : true}
      data-strokes={strokes.length}
      {...handlers}
    />
  );
}

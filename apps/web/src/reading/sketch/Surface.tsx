import { useCallback } from 'react';
import buttons from '../../components/Buttons.module.css';
import styles from './Sketch.module.css';
import { SketchCanvas } from './SketchCanvas';
import { SketchPanel } from './SketchPanel';
import { type Sketches, type Surface, sameSurface, surfaceKey } from './useSketches';

const strokesOfSaved = (a: { anchor: { kind: string; strokes?: unknown } }) =>
  (a.anchor.kind === 'figure' || a.anchor.kind === 'pdf'
    ? ((a.anchor as { strokes?: never[] }).strokes ?? [])
    : []) as never[];

/**
 * The ink over one surface: the sketches already saved there, and the open one with its pen. It
 * fills the positioned parent it is rendered into.
 */
export function SketchLayer({
  surface,
  api,
  label,
}: {
  surface: Surface;
  api: Sketches;
  label: string;
}) {
  const key = surfaceKey(surface);
  const onSize = useCallback(
    (w: number, h: number) => api.aspects.current.set(key, h / w),
    [api.aspects, key],
  );
  const editing = api.open && sameSurface(api.open.surface, surface) ? api.open : null;
  // A sketch being edited is drawn from the editor's copy; the rest stay as they are saved, each
  // on its own canvas so one sketch's eraser never cuts another's ink.
  const others = api.saved.filter(
    (s) =>
      s.surface && sameSurface(s.surface, surface) && s.annotation.id !== editing?.annotationId,
  );
  const drawing = editing && editing.mode === 'draw' ? editing : null;
  return (
    <div className={styles.layer}>
      {others.length === 0 ? <SketchCanvas strokes={[]} label={label} onSize={onSize} /> : null}
      {others.map((s) => (
        <SketchCanvas
          key={s.annotation.id}
          strokes={strokesOfSaved(s.annotation)}
          label={label}
          onSize={onSize}
        />
      ))}
      {drawing ? (
        <SketchCanvas
          strokes={drawing.history.strokes}
          label={label}
          pen={
            drawing.status === 'saving'
              ? null
              : {
                  tool: drawing.tool,
                  color: drawing.color,
                  width: drawing.width,
                  onStroke: api.draw,
                }
          }
        />
      ) : null}
    </div>
  );
}

/** Sketch and Describe in text, on the figure or page (not on the selection toolbar, §8). */
export function SketchTools({
  surface,
  api,
  label,
}: {
  surface: Surface;
  api: Sketches;
  label: string;
}) {
  const here = api.open && sameSurface(api.open.surface, surface);
  if (here) return null;
  const blocked = api.open !== null;
  return (
    <div className={styles.tools}>
      <button
        type="button"
        className={buttons.tool}
        disabled={blocked}
        aria-label={`${api.savedOn(surface) ? 'Edit sketch' : 'Sketch'} on ${label}`}
        onClick={() => api.begin(surface, 'draw')}
      >
        {api.savedOn(surface) ? 'Edit sketch' : 'Sketch'}
      </button>
      <button
        type="button"
        className={buttons.tool}
        disabled={blocked}
        aria-label={`Describe ${label} in text`}
        onClick={() => api.begin(surface, 'describe')}
      >
        Describe in text
      </button>
    </div>
  );
}

/** The open sketch's controls, when it is on this surface. */
export function SketchControls({
  surface,
  api,
  label,
}: {
  surface: Surface;
  api: Sketches;
  label: string;
}) {
  return api.open && sameSurface(api.open.surface, surface) ? (
    <SketchPanel api={api} label={label} />
  ) : null;
}

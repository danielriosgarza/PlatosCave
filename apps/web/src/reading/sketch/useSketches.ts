import type { Anchor, Strokes } from '@parallax/contracts';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { Annotation, MarginActions } from '../margin/data';
import { shownAnchor } from '../margin/placement';
import { bounds, emptyHistory, type History, push, redo, type Stroke, undo } from './strokes';

/** Where a drawing sits: a native figure, or a PDF page (0-based, as in the `pdf` anchor). */
export type Surface = { kind: 'figure'; figureId: string } | { kind: 'page'; page: number };

export const surfaceKey = (s: Surface) =>
  s.kind === 'figure' ? `figure:${s.figureId}` : `page:${s.page}`;

export const sameSurface = (a: Surface, b: Surface) => surfaceKey(a) === surfaceKey(b);

/** The surface an anchor names, when it is one a drawing can sit on. */
export function surfaceOf(anchor: Anchor | null): Surface | null {
  if (anchor?.kind === 'figure') return { kind: 'figure', figureId: anchor.figureId };
  if (anchor?.kind === 'pdf') return { kind: 'page', page: anchor.page };
  return null;
}

export const PALETTE = [
  { name: 'Ink', value: '#202124' },
  { name: 'Slate', value: '#60646c' },
  { name: 'Green', value: '#315747' },
  { name: 'Rust', value: '#8a3b12' },
  { name: 'Blue', value: '#1f4e8c' },
] as const;
/** Pen widths in pixels of a surface 900 px wide (see `SKETCH_REFERENCE_WIDTH`). */
export const WIDTHS = [2, 4, 8] as const;
/** The eraser's width, in the same units as a pen's. */
export const ERASER_WIDTH = 24;

export type Tool = 'pen' | 'eraser';
export type SaveStatus = 'idle' | 'saving' | 'offline' | 'failed' | 'invalid' | 'conflict';

export interface Session {
  surface: Surface;
  /** The saved sketch being edited; null for a new one. */
  annotationId: string | null;
  revision: number | null;
  /** `describe` is the way in without drawing: the same explanation in words alone. */
  mode: 'draw' | 'describe';
  history: History;
  description: string;
  tool: Tool;
  color: string;
  width: number;
  status: SaveStatus;
  message: string | null;
  /** The server's copy, while a save found it changed elsewhere. */
  current: Annotation | null;
}

/** The anchor a drawing is stored on: figure strokes, or a page sketch with its bounding box. */
function anchorFor(surface: Surface, strokes: Strokes): Anchor {
  if (surface.kind === 'figure') return { kind: 'figure', figureId: surface.figureId, strokes };
  return strokes.length
    ? { kind: 'pdf', page: surface.page, rect: bounds(strokes), strokes }
    : { kind: 'pdf', page: surface.page, rect: { x: 0, y: 0, w: 1, h: 1 } };
}

const strokesOf = (a: Annotation): Strokes =>
  a.anchor.kind === 'figure' || a.anchor.kind === 'pdf' ? (a.anchor.strokes ?? []) : [];

const fresh = (surface: Surface, mode: Session['mode']): Session => ({
  surface,
  annotationId: null,
  revision: null,
  mode,
  history: emptyHistory(),
  description: '',
  tool: 'pen',
  color: PALETTE[0].value,
  width: WIDTHS[1],
  status: 'idle',
  message: null,
  current: null,
});

const fromSaved = (a: Annotation, surface: Surface): Session => ({
  ...fresh(surface, 'draw'),
  annotationId: a.id,
  revision: a.revision,
  history: emptyHistory(strokesOf(a)),
  description: a.body ?? '',
});

export interface Sketches {
  open: Session | null;
  /** Saved sketches (not descriptions) and where they sit today. */
  saved: { annotation: Annotation; surface: Surface | null; editable: boolean }[];
  savedOn(surface: Surface): Annotation | undefined;
  /** The height-over-width of each surface as last drawn, for the SVG export. */
  aspects: React.MutableRefObject<Map<string, number>>;
  begin(surface: Surface, mode?: Session['mode']): void;
  edit(annotation: Annotation): void;
  draw(stroke: Stroke): void;
  undo(): void;
  redo(): void;
  setDescription(text: string): void;
  setTool(tool: Tool): void;
  setColor(color: string): void;
  setWidth(width: number): void;
  cancel(): void;
  done(): Promise<void>;
  keepMine(): void;
  useSaved(): void;
}

export function useSketches(actions: MarginActions, annotations: Annotation[]): Sketches {
  const [open, setOpen] = useState<Session | null>(null);
  const latest = useRef<Session | null>(null);
  latest.current = open;
  const aspects = useRef(new Map<string, number>());

  const saved = useMemo(
    () =>
      annotations
        .filter((a) => a.kind === 'sketch')
        .map((annotation) => ({
          annotation,
          surface: surfaceOf(shownAnchor(annotation)),
          // A save writes the sketch's own anchor, which belongs to the revision it was made on:
          // only a sketch still placed as made (or never mapped) can be edited in place.
          editable: !annotation.placement || annotation.placement.status === 'original',
        })),
    [annotations],
  );
  const savedOn = useCallback(
    (surface: Surface) =>
      saved.find((s) => s.editable && s.surface && sameSurface(s.surface, surface))?.annotation,
    [saved],
  );

  const patch = useCallback((changes: Partial<Session>) => {
    setOpen((s) => (s ? { ...s, ...changes } : s));
  }, []);
  const reset = (s: Session): Partial<Session> =>
    s.status === 'idle' ? {} : { status: 'idle', message: null };

  return {
    open,
    saved,
    savedOn,
    aspects,
    begin: (surface, mode = 'draw') => {
      const existing = mode === 'draw' ? savedOn(surface) : undefined;
      setOpen(existing ? fromSaved(existing, surface) : fresh(surface, mode));
    },
    edit: (annotation) => {
      // Never replaces a sketch the reader has open, and only edits one placed as made.
      if (latest.current) return;
      if (annotation.placement && annotation.placement.status !== 'original') return;
      const surface = surfaceOf(annotation.anchor);
      if (surface) setOpen(fromSaved(annotation, surface));
    },
    draw: (stroke) =>
      setOpen((s) => (s ? { ...s, ...reset(s), history: push(s.history, stroke) } : s)),
    undo: () => setOpen((s) => (s ? { ...s, history: undo(s.history) } : s)),
    redo: () => setOpen((s) => (s ? { ...s, history: redo(s.history) } : s)),
    setDescription: (description) => setOpen((s) => (s ? { ...s, ...reset(s), description } : s)),
    setTool: (tool) => patch({ tool }),
    setColor: (color) => patch({ color, tool: 'pen' }),
    setWidth: (width) => patch({ width }),
    cancel: () => setOpen(null),
    keepMine: () =>
      setOpen((s) =>
        s?.current ? { ...s, revision: s.current.revision, current: null, status: 'idle' } : s,
      ),
    useSaved: () => setOpen((s) => (s?.current ? fromSaved(s.current, s.surface) : s)),
    async done() {
      const s = latest.current;
      if (!s || s.status === 'saving') return;
      const body = s.description.trim();
      const strokes = s.history.strokes;
      if (body === '') {
        return patch({
          status: 'invalid',
          message:
            s.mode === 'draw'
              ? 'Describe the sketch in words before finishing.'
              : 'Write the description before saving.',
        });
      }
      if (s.mode === 'draw' && !strokes.some((x) => x.tool === 'pen')) {
        return patch({
          status: 'invalid',
          message: 'Draw at least one stroke, or describe the figure in text instead.',
        });
      }
      patch({ status: 'saving', message: null });
      const anchor = anchorFor(s.surface, s.mode === 'draw' ? strokes : []);
      const result =
        s.mode === 'describe'
          ? await actions.createNote(anchor, body)
          : s.annotationId && s.revision !== null
            ? await actions.saveSketch(s.annotationId, s.revision, anchor, body)
            : await actions.createSketch(anchor, body);
      if (result.kind === 'ok') return setOpen(null);
      if (result.kind === 'conflict') {
        return patch({ status: 'conflict', current: result.current, message: null });
      }
      if (result.kind === 'gone') {
        if (s.annotationId) actions.forget(s.annotationId);
        return patch({
          status: 'failed',
          annotationId: null,
          revision: null,
          message: 'This sketch was deleted elsewhere. Done saves it again as a new sketch.',
        });
      }
      patch(
        result.kind === 'offline'
          ? { status: 'offline', message: null }
          : { status: 'failed', message: result.reason },
      );
    },
  };
}

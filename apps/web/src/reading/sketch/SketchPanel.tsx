import { useEffect, useRef } from 'react';
import buttons from '../../components/Buttons.module.css';
import styles from './Sketch.module.css';
import { PALETTE, type Sketches, WIDTHS } from './useSketches';

/** The controls of the open sketch, beside the surface it is drawn on (§8). */
export function SketchPanel({ api, label }: { api: Sketches; label: string }) {
  const s = api.open;
  const description = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLElement>(null);
  // Read while rendering, before the button that opened the sketch is disabled or removed.
  const opener = useRef<{ element: Element | null; key: string | null } | null>(null);
  if (!opener.current) {
    const element = document.activeElement;
    const marked = element instanceof HTMLElement ? element.closest('[data-return-focus]') : null;
    opener.current = {
      element: element === document.body ? null : element,
      key: marked instanceof HTMLElement ? (marked.dataset.returnFocus ?? null) : null,
    };
  }
  const describing = s?.mode === 'describe';
  const sessionId = s ? `${s.annotationId ?? 'new'}|${s.mode}` : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: focuses once per opened session
  useEffect(() => {
    if (describing) description.current?.focus();
  }, [sessionId]);
  // The panel exists while a sketch is open: focus enters it, and returns to what opened it on close.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per mount, which is one session
  useEffect(() => {
    if (!describing) panel.current?.focus();
    return () => {
      const from = opener.current;
      const active = document.activeElement;
      if (!from || (active && active !== document.body)) return;
      const again = from.key
        ? ([...document.querySelectorAll<HTMLElement>('[data-return-focus]')].find(
            (e) => e.dataset.returnFocus === from.key,
          ) ?? null)
        : null;
      const target = from.element?.isConnected ? from.element : again;
      if (target instanceof HTMLElement) target.focus();
    };
  }, []);
  useEffect(() => {
    if (s?.status === 'invalid') description.current?.focus();
  }, [s?.status]);
  if (!s) return null;
  const saving = s.status === 'saving';
  const strokes = s.history.strokes.length;
  return (
    <section ref={panel} tabIndex={-1} className={styles.panel} aria-label={`Sketch on ${label}`}>
      <div className={styles.head}>
        <span className={styles.small}>
          {describing ? `Private description · ${label}` : `Private sketch · ${label}`}
        </span>
        {describing ? null : (
          <div className={styles.row}>
            <button
              type="button"
              className={buttons.tool}
              disabled={saving || s.history.strokes.length === 0}
              onClick={api.undo}
            >
              Undo
            </button>
            <button
              type="button"
              className={buttons.tool}
              disabled={saving || s.history.undone.length === 0}
              onClick={api.redo}
            >
              Redo
            </button>
          </div>
        )}
      </div>
      {describing ? null : (
        // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring its own border and legend
        <div className={styles.pens} role="group" aria-label="Pen">
          <button
            type="button"
            className={buttons.tool}
            aria-pressed={s.tool === 'pen'}
            onClick={() => api.setTool('pen')}
          >
            Pen
          </button>
          <button
            type="button"
            className={buttons.tool}
            aria-pressed={s.tool === 'eraser'}
            onClick={() => api.setTool('eraser')}
          >
            Eraser
          </button>
          {PALETTE.map((c) => (
            <button
              key={c.value}
              type="button"
              className={styles.swatch}
              style={{ background: c.value }}
              aria-label={`Colour ${c.name}`}
              aria-pressed={s.tool === 'pen' && s.color === c.value}
              onClick={() => api.setColor(c.value)}
            />
          ))}
          <label className={styles.width}>
            Width
            <select value={s.width} onChange={(e) => api.setWidth(Number(e.target.value))}>
              {WIDTHS.map((w, i) => (
                <option key={w} value={w}>
                  {['Thin', 'Medium', 'Thick'][i]}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <label className={styles.field}>
        Text description (required)
        <textarea
          ref={description}
          rows={3}
          value={s.description}
          placeholder={describing ? 'Explain it in words.' : 'Describe what you drew.'}
          onChange={(e) => api.setDescription(e.target.value)}
        />
      </label>
      {s.status === 'conflict' && s.current ? (
        <div className={styles.conflict} role="alert">
          <h3>This sketch changed somewhere else</h3>
          <p className={styles.small}>Saved description</p>
          <pre>{s.current.body ?? ''}</pre>
          <div className={styles.row}>
            <button type="button" className={buttons.outline} onClick={api.keepMine}>
              Keep my drawing
            </button>
            <button type="button" className={buttons.outline} onClick={api.useSaved}>
              Use the saved sketch
            </button>
          </div>
        </div>
      ) : null}
      <div className={styles.status} role="status">
        {saving
          ? 'Saving'
          : s.status === 'offline'
            ? 'Offline · not saved. Press Done when you are back online.'
            : s.status === 'failed'
              ? `${s.message ?? 'Could not save'} · press Done to retry`
              : s.status === 'invalid'
                ? s.message
                : describing
                  ? null
                  : `${strokes} ${strokes === 1 ? 'stroke' : 'strokes'}`}
      </div>
      <div className={styles.row}>
        <button
          type="button"
          className={buttons.primary}
          disabled={saving}
          onClick={() => void api.done()}
        >
          {describing ? 'Save description' : 'Done'}
        </button>
        <button type="button" className={buttons.outline} disabled={saving} onClick={api.cancel}>
          Discard
        </button>
      </div>
    </section>
  );
}

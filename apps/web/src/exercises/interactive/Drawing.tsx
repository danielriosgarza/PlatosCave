import type { InteractiveView } from '@parallax/contracts';
import { useId, useState } from 'react';
import buttons from '../../components/Buttons.module.css';
import { SketchCanvas } from '../../reading/sketch/SketchCanvas';
import { push, redo, type Stroke, undo } from '../../reading/sketch/strokes';
import { PALETTE, type Tool, WIDTHS } from '../../reading/sketch/useSketches';
import type { InteractiveDraft } from './draft';
import { frameFor } from './geometry';
import styles from './Interactive.module.css';
import { Scene, useWidth } from './Scene';

type View = Extract<InteractiveView, { kind: 'drawing' }>;
type Draft = Extract<InteractiveDraft, { kind: 'drawing' }>;

/**
 * A freehand drawing saved for the instructor (§9, A07): pen colours, an eraser, Undo and Redo,
 * on a blank sheet or over the step's scene. The text description is the way in without a
 * pointer: a drawing or a description is enough to save the step.
 */
export function Drawing({
  view,
  draft,
  disabled,
  label,
  onChange,
}: {
  view: View;
  draft: Draft;
  disabled: boolean;
  label: string;
  onChange: (draft: Draft) => void;
}) {
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState<string>(PALETTE[0].value);
  const [width, setWidth] = useState<number>(WIDTHS[1]);
  const field = useId();
  const history = { strokes: draft.strokes, undone: draft.undone };
  const keep = (h: { strokes: Draft['strokes']; undone: Draft['undone'] }) =>
    onChange({ ...draft, strokes: h.strokes, undone: h.undone });
  const [box, available] = useWidth<HTMLDivElement>();
  // Over a scene the sheet is the scene's frame; a blank sheet keeps the step's proportions.
  const frame = view.scene ? frameFor(view.scene, available) : null;
  const sheetWidth = frame?.width ?? Math.min(available, 680);
  const sheetHeight = frame?.height ?? sheetWidth / view.aspect;

  return (
    <div className={styles.board}>
      {disabled ? null : (
        // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring its own border and legend
        <div className={styles.drawTools} role="group" aria-label="Pen">
          <button
            type="button"
            className={buttons.tool}
            aria-pressed={tool === 'pen'}
            onClick={() => setTool('pen')}
          >
            Pen
          </button>
          <button
            type="button"
            className={buttons.tool}
            aria-pressed={tool === 'eraser'}
            onClick={() => setTool('eraser')}
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
              aria-pressed={tool === 'pen' && color === c.value}
              onClick={() => {
                setTool('pen');
                setColor(c.value);
              }}
            />
          ))}
          <label className={styles.inlineField}>
            Width
            <select value={width} onChange={(e) => setWidth(Number(e.target.value))}>
              {WIDTHS.map((w, i) => (
                <option key={w} value={w}>
                  {['Thin', 'Medium', 'Thick'][i]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={buttons.tool}
            disabled={draft.strokes.length === 0}
            onClick={() => keep(undo(history))}
          >
            Undo
          </button>
          <button
            type="button"
            className={buttons.tool}
            disabled={draft.undone.length === 0}
            onClick={() => keep(redo(history))}
          >
            Redo
          </button>
        </div>
      )}
      <div ref={box} className={styles.sheetBox}>
        <div className={styles.sheet} style={{ width: sheetWidth, height: sheetHeight }}>
          {view.scene ? <Scene scene={view.scene} label={label} /> : null}
          <SketchCanvas
            strokes={draft.strokes}
            label={label}
            pen={
              disabled
                ? null
                : { tool, color, width, onStroke: (stroke: Stroke) => keep(push(history, stroke)) }
            }
          />
        </div>
      </div>
      <p className={styles.readout}>
        {`${draft.strokes.length} ${draft.strokes.length === 1 ? 'stroke' : 'strokes'}`}
      </p>
      <div className={styles.describe}>
        <label htmlFor={field}>Describe your drawing</label>
        <textarea
          id={field}
          rows={3}
          maxLength={4000}
          value={draft.description}
          disabled={disabled}
          placeholder="What you drew, in words. A description alone also saves this step."
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
        />
      </div>
    </div>
  );
}

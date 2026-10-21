import type { InteractiveView } from '@parallax/contracts';
import type { KeyboardEvent } from 'react';
import type { InteractiveDraft } from './draft';
import { type Frame, round, type XY } from './geometry';
import styles from './Interactive.module.css';
import { Scene } from './Scene';
import { Mark } from './tokens';

type View = Extract<InteractiveView, { kind: 'hotspot' }>;
type Draft = Extract<InteractiveDraft, { kind: 'hotspot' }>;
type Region = View['regions'][number];

/** A region's outline as an SVG path in the frame. */
function regionPath(region: Region, frame: Frame): string {
  const { shape } = region;
  const at = (p: XY) => frame.toScreen(p).map(round).join(' ');
  switch (shape.type) {
    case 'circle': {
      const [cx, cy] = frame.toScreen(shape.center);
      const rx = round(shape.r * frame.kx);
      const ry = round(shape.r * frame.ky);
      return `M${round(cx - rx)} ${round(cy)}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;
    }
    case 'rect': {
      const [x, y] = shape.at;
      const [w, h] = shape.size;
      return `M${at([x, y])}L${at([x + w, y])}L${at([x + w, y + h])}L${at([x, y + h])}Z`;
    }
    case 'polygon':
      return `M${shape.points.map(at).join('L')}Z`;
  }
}

/**
 * Choose regions of a figure (§9). Each region is a radio button (one to choose) or a checkbox
 * (several) drawn on the figure: click it, or Tab to it and press Space.
 */
export function Hotspot({
  view,
  draft,
  disabled,
  parts,
  label,
  onChange,
}: {
  view: View;
  draft: Draft;
  disabled: boolean;
  parts?: Record<string, boolean> | null;
  label: string;
  onChange: (draft: Draft) => void;
}) {
  const toggle = (id: string) => {
    if (disabled) return;
    const on = draft.picked.includes(id);
    const picked = view.multiple
      ? on
        ? draft.picked.filter((p) => p !== id)
        : [...draft.picked, id]
      : [id];
    onChange({ kind: 'hotspot', picked });
  };
  const names = new Map(view.regions.map((r) => [r.id, r.label]));
  return (
    <div className={styles.board}>
      <Scene scene={view.scene} label={label} interactive={!disabled}>
        {(frame) => (
          <g role={view.multiple ? 'group' : 'radiogroup'} aria-label="Regions to choose">
            {view.regions.map((r, i) => {
              const on = draft.picked.includes(r.id);
              const mark = on ? parts?.[r.id] : undefined;
              const props = {
                className: on ? `${styles.region} ${styles.regionOn}` : styles.region,
                d: regionPath(r, frame),
                'aria-label':
                  mark === undefined ? r.label : `${r.label}, ${mark ? 'right' : 'not right yet'}`,
                'aria-disabled': disabled || undefined,
                'data-mark': mark,
                'data-region': r.id,
                tabIndex: disabled ? -1 : 0,
                onClick: () => toggle(r.id),
                onKeyDown: (e: KeyboardEvent<SVGPathElement>) => {
                  if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault();
                    toggle(r.id);
                    return;
                  }
                  // The arrow keys go from region to region, as in any group of choices.
                  const by = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
                  if (!by) return;
                  e.preventDefault();
                  const next = view.regions[(i + by + view.regions.length) % view.regions.length];
                  if (!next) return;
                  e.currentTarget.ownerSVGElement
                    ?.querySelector<SVGPathElement>(`[data-region="${CSS.escape(next.id)}"]`)
                    ?.focus();
                  if (!view.multiple && !disabled) onChange({ kind: 'hotspot', picked: [next.id] });
                },
              };
              return view.multiple ? (
                // biome-ignore lint/a11y/useSemanticElements: a region of a figure has no native checkbox
                <path key={r.id} role="checkbox" aria-checked={on} {...props} />
              ) : (
                // biome-ignore lint/a11y/useSemanticElements: a region of a figure has no native radio button
                <path key={r.id} role="radio" aria-checked={on} {...props} />
              );
            })}
          </g>
        )}
      </Scene>
      <p className={styles.readout} aria-live="polite">
        {draft.picked.length === 0 ? (
          'Nothing chosen yet.'
        ) : (
          <>
            {'Chosen: '}
            {draft.picked.map((id, i) => (
              <span key={id}>
                {i > 0 ? ', ' : ''}
                {names.get(id) ?? id}
                {parts?.[id] === undefined ? null : <Mark right={parts[id] as boolean} />}
              </span>
            ))}
          </>
        )}
      </p>
    </div>
  );
}

import type { InteractiveView } from '@parallax/contracts';
import type { InteractiveDraft } from './draft';
import { moveIntoSlot } from './FillBlanks';
import styles from './Interactive.module.css';
import { Scene } from './Scene';
import { BANK, TokenFace, useTokenDrag } from './tokens';

type View = Extract<InteractiveView, { kind: 'label_diagram' }>;
type Draft = Extract<InteractiveDraft, { kind: 'label_diagram' }>;

/** Put labels on a diagram: each target, numbered on the drawing, takes one label (§9). */
export function LabelDiagram({
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
  const labels = new Map(view.labels.map((l) => [l.id, l.label]));
  const icons = new Map(view.labels.map((l) => [l.id, l.icon]));
  const iconsOnly = view.iconsOnly ?? false;
  const tokenClass = (id: string) =>
    iconsOnly && icons.get(id) ? `${styles.token} ${styles.iconToken}` : styles.token;
  const number = (target: string) => view.targets.findIndex((t) => t.id === target) + 1;
  const drag = useTokenDrag({
    disabled,
    iconsOnly,
    tokenIcon: (id) => icons.get(id),
    tokenLabel: (id) => labels.get(id) ?? id,
    slotLabel: (id) => (id === BANK ? 'the labels' : `target ${number(id)}`),
    onMove: (move) =>
      onChange({ kind: 'label_diagram', filled: moveIntoSlot(draft.filled, move, view.reuse) }),
  });
  const placed = new Set(Object.values(draft.filled));
  const bank = view.labels.filter((l) => view.reuse || !placed.has(l.id));
  return (
    <div className={styles.board}>
      <Scene
        scene={view.scene}
        label={label}
        overlay={(frame) =>
          view.targets.map((t, i) => {
            const [x, y] = frame.toScreen(t.at);
            const tile = draft.filled[t.id];
            const mark = parts?.[t.id];
            return (
              // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring its own border and legend to a small target
              <div
                key={t.id}
                className={styles.target}
                style={{ left: x, top: y }}
                data-mark={mark}
                role="group"
                aria-label={`Target ${i + 1}`}
                {...drag.slotProps(t.id)}
              >
                {tile ? (
                  <button
                    type="button"
                    className={tokenClass(tile)}
                    {...drag.tokenProps(tile, t.id)}
                  >
                    <TokenFace
                      label={labels.get(tile) ?? tile}
                      icon={icons.get(tile)}
                      iconOnly={iconsOnly}
                      mark={mark}
                    />
                  </button>
                ) : (
                  <span className={styles.targetEmpty} aria-hidden={drag.picked ? true : undefined}>
                    {i + 1}
                  </span>
                )}
                {drag.dropButton(t.id, styles.targetDrop)}
              </div>
            );
          })
        }
      />
      <section className={styles.bank} aria-label="Labels" {...drag.slotProps(BANK)}>
        {bank.length ? (
          <ul className={styles.tokens}>
            {bank.map((l) => (
              <li key={l.id}>
                <button type="button" className={tokenClass(l.id)} {...drag.tokenProps(l.id, BANK)}>
                  <TokenFace label={l.label} icon={l.icon} iconOnly={iconsOnly} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.empty}>Every label is placed.</p>
        )}
        {drag.picked && drag.picked.from !== BANK ? drag.dropButton(BANK) : null}
      </section>
      {drag.layer}
    </div>
  );
}

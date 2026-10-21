import type { InteractiveView } from '@parallax/contracts';
import { Fragment } from 'react';
import type { InteractiveDraft } from './draft';
import styles from './Interactive.module.css';
import { BANK, Mark, TokenFace, useTokenDrag } from './tokens';

type View = Extract<InteractiveView, { kind: 'fill_blanks' }>;
type Draft = Extract<InteractiveDraft, { kind: 'fill_blanks' }>;

/** The text split at its `[[gap]]` markers: text, gap, text, … */
export function segments(text: string): ({ text: string } | { gap: string })[] {
  return text
    .split(/\[\[([^\]]*)\]\]/)
    .map((part, i) => (i % 2 === 0 ? { text: part } : { gap: part }))
    .filter((s) => !('text' in s) || s.text !== '');
}

/**
 * Moves `token` from slot `from` to `to` in a map of one-token slots. A token leaves the slot it
 * was in; without `reuse` it also leaves any other slot, so each fills one; one already in `to`
 * goes back to the bank.
 */
export function moveIntoSlot(
  filled: Record<string, string>,
  { token, from, to }: { token: string; from: string; to: string },
  reuse: boolean,
): Record<string, string> {
  const next = { ...filled };
  if (from !== BANK) delete next[from];
  if (to === BANK) return next;
  if (!reuse) {
    for (const [slot, t] of Object.entries(next)) if (t === token) delete next[slot];
  }
  next[to] = token;
  return next;
}

/** Fill the gaps of a sentence or formula: with tiles to drag, or typed (§9). */
export function FillBlanks({
  view,
  draft,
  disabled,
  parts,
  onChange,
}: {
  view: View;
  draft: Draft;
  disabled: boolean;
  parts?: Record<string, boolean> | null;
  onChange: (draft: Draft) => void;
}) {
  const tiles = new Map((view.tiles ?? []).map((t) => [t.id, t.label]));
  const icons = new Map((view.tiles ?? []).map((t) => [t.id, t.icon]));
  const iconsOnly = view.iconsOnly ?? false;
  const tokenClass = (id: string) =>
    iconsOnly && icons.get(id) ? `${styles.token} ${styles.iconToken}` : styles.token;
  const number = (gap: string) => view.gaps.indexOf(gap) + 1;
  const drag = useTokenDrag({
    disabled,
    iconsOnly,
    tokenIcon: (id) => icons.get(id),
    tokenLabel: (id) => tiles.get(id) ?? id,
    slotLabel: (id) => (id === BANK ? 'the tiles' : `gap ${number(id)}`),
    onMove: (move) =>
      onChange({ kind: 'fill_blanks', filled: moveIntoSlot(draft.filled, move, view.reuse) }),
  });
  const typed = !view.tiles;
  const placed = new Set(Object.values(draft.filled));
  const bank = (view.tiles ?? []).filter((t) => view.reuse || !placed.has(t.id));
  return (
    <div className={styles.board}>
      <p className={styles.blanks}>
        {segments(view.text).map((s, i) => {
          if ('text' in s) {
            // Text runs are positional pieces of one sentence.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            return <Fragment key={i}>{s.text}</Fragment>;
          }
          const gap = s.gap;
          const mark = parts?.[gap];
          if (typed) {
            return (
              <span key={gap} className={styles.typedGap}>
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={`Gap ${number(gap)}`}
                  value={draft.filled[gap] ?? ''}
                  disabled={disabled}
                  size={Math.max(4, (draft.filled[gap] ?? '').length + 1)}
                  onChange={(e) =>
                    onChange({
                      kind: 'fill_blanks',
                      filled: { ...draft.filled, [gap]: e.target.value },
                    })
                  }
                />
                {mark === undefined ? null : <Mark right={mark} />}
              </span>
            );
          }
          const tile = draft.filled[gap];
          return (
            <span key={gap} className={styles.gap} data-mark={mark} {...drag.slotProps(gap)}>
              {tile ? (
                <button type="button" className={tokenClass(tile)} {...drag.tokenProps(tile, gap)}>
                  <TokenFace
                    label={tiles.get(tile) ?? tile}
                    icon={icons.get(tile)}
                    iconOnly={iconsOnly}
                    mark={mark}
                  />
                </button>
              ) : (
                (drag.dropButton(gap, styles.gapDrop) ?? (
                  <span className={styles.gapEmpty}>
                    <span className={styles.visuallyHidden}>{`Gap ${number(gap)}, empty`}</span>
                  </span>
                ))
              )}
              {tile ? drag.dropButton(gap, styles.gapDrop) : null}
            </span>
          );
        })}
      </p>
      {typed ? null : (
        <section className={styles.bank} aria-label="Tiles" {...drag.slotProps(BANK)}>
          {bank.length ? (
            <ul className={styles.tokens}>
              {bank.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className={tokenClass(t.id)}
                    {...drag.tokenProps(t.id, BANK)}
                  >
                    <TokenFace label={t.label} icon={t.icon} iconOnly={iconsOnly} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.empty}>Every tile is placed.</p>
          )}
          {drag.picked && drag.picked.from !== BANK ? drag.dropButton(BANK) : null}
        </section>
      )}
      {drag.layer}
    </div>
  );
}

import type { InteractiveView } from '@parallax/contracts';
import type { InteractiveDraft } from './draft';
import styles from './Interactive.module.css';
import { Glyph } from './icon';
import { BANK, TokenFace, useTokenDrag } from './tokens';

type View = Extract<InteractiveView, { kind: 'categorize' }>;
type Draft = Extract<InteractiveDraft, { kind: 'categorize' }>;

/** Sort items into groups: drag them, or pick one and choose its group (§9). */
export function Categorize({
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
  const items = new Map(view.items.map((i) => [i.id, i.label]));
  const icons = new Map(view.items.map((i) => [i.id, i.icon]));
  const groups = new Map(view.categories.map((c) => [c.id, c.label]));
  const iconsOnly = view.iconsOnly ?? false;
  const drag = useTokenDrag({
    disabled,
    iconsOnly,
    tokenIcon: (id) => icons.get(id),
    tokenLabel: (id) => items.get(id) ?? id,
    slotLabel: (id) => (id === BANK ? 'the unsorted items' : `the group ${groups.get(id) ?? id}`),
    onMove: ({ token, to }) => {
      const placed = { ...draft.placed };
      if (to === BANK) delete placed[token];
      else placed[token] = to;
      onChange({ kind: 'categorize', placed });
    },
  });
  const token = (id: string, from: string) => (
    <li key={id}>
      <button
        type="button"
        className={
          iconsOnly && icons.get(id) ? `${styles.token} ${styles.iconToken}` : styles.token
        }
        data-mark={from === BANK ? undefined : parts?.[id]}
        {...drag.tokenProps(id, from)}
      >
        <TokenFace
          label={items.get(id) ?? id}
          icon={icons.get(id)}
          iconOnly={iconsOnly}
          mark={from === BANK ? undefined : parts?.[id]}
        />
      </button>
    </li>
  );
  const unsorted = view.items.filter((i) => !draft.placed[i.id]);
  return (
    <div className={styles.board}>
      <section className={styles.bank} aria-label="Unsorted items" {...drag.slotProps(BANK)}>
        <h4 className={styles.slotName}>To sort</h4>
        {unsorted.length ? (
          <ul className={styles.tokens}>{unsorted.map((i) => token(i.id, BANK))}</ul>
        ) : (
          <p className={styles.empty}>Every item is in a group.</p>
        )}
        {drag.picked && drag.picked.from !== BANK ? drag.dropButton(BANK) : null}
      </section>
      <div className={styles.groups}>
        {view.categories.map((c) => {
          const inside = view.items.filter((i) => draft.placed[i.id] === c.id);
          return (
            <section
              key={c.id}
              className={styles.group}
              aria-label={`Group ${c.label}`}
              {...drag.slotProps(c.id)}
            >
              <h4 className={styles.slotName}>
                {c.icon ? <Glyph name={c.icon} size={20} /> : null}
                {c.label}
              </h4>
              {inside.length ? (
                <ul className={styles.tokens}>{inside.map((i) => token(i.id, c.id))}</ul>
              ) : (
                <p className={styles.empty}>Drop items here.</p>
              )}
              {drag.dropButton(c.id)}
            </section>
          );
        })}
      </div>
      {drag.layer}
    </div>
  );
}

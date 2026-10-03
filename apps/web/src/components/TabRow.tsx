import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import styles from './TabRow.module.css';

export interface TabDef<Id extends string> {
  id: Id;
  label: string;
}

interface TabRowProps<Id extends string> {
  label: string;
  tabs: readonly TabDef<Id>[];
  selected: Id;
  onSelect: (id: Id) => void;
  /** Id of the element the tabs control (the tab panel). */
  panelId: string;
  idPrefix?: string;
}

/** ARIA tabs with automatic activation: arrows, Home and End move and select (roving tabindex). */
export function TabRow<Id extends string>({
  label,
  tabs,
  selected,
  onSelect,
  panelId,
  idPrefix = 'pc-tab',
}: TabRowProps<Id>) {
  const refs = useRef(new Map<Id, HTMLButtonElement>());
  const strip = useRef<HTMLDivElement | null>(null);
  // At narrow widths the strip scrolls on its own; a fade marks the edge that has more tabs (§5).
  const [more, setMore] = useState(false);
  const tabIds = tabs.map((t) => t.id).join('\n');
  const measure = useCallback(() => {
    const el = strip.current;
    if (el) setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a changed set of tabs (`tabIds`) changes the width to measure
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    const el = strip.current;
    const observer =
      el && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : undefined;
    if (el) observer?.observe(el);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [measure, tabIds]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((t) => t.id === selected);
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const target = tabs[next];
    if (!target) return;
    onSelect(target.id);
    refs.current.get(target.id)?.focus();
  };

  return (
    <div className={styles.wrap} data-more={more}>
      <div
        ref={strip}
        className={styles.tabs}
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        onScroll={measure}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${idPrefix}-${tab.id}`}
            aria-selected={tab.id === selected}
            aria-controls={panelId}
            tabIndex={tab.id === selected ? 0 : -1}
            ref={(el) => {
              if (el) refs.current.set(tab.id, el);
              else refs.current.delete(tab.id);
            }}
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  );
}

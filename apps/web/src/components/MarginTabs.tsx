import type { ReactNode } from 'react';
import { TabRow } from './TabRow';
import styles from './TabRow.module.css';

export type MarginTab = 'notes' | 'discussion';

interface MarginTabsProps {
  tab: MarginTab;
  onTab: (tab: MarginTab) => void;
  /** Threads shown beside "Discussion". */
  count: number;
  /** Distinguishes the ids when two margins are on one page. */
  idPrefix?: string;
  /** The panel of the selected tab. */
  children: ReactNode;
}

/** "My notes / Discussion" above a margin: ARIA tabs (TabRow) with the selected panel below. */
export function MarginTabs({ tab, onTab, count, idPrefix = 'margin', children }: MarginTabsProps) {
  const panelId = `${idPrefix}-panel`;
  const tabs = [
    { id: 'notes', label: 'My notes' },
    {
      id: 'discussion',
      label: (
        <>
          Discussion <span className={styles.count}>{count}</span>
        </>
      ),
    },
  ] as const;
  return (
    <>
      <TabRow
        label="Notes and discussion"
        tabs={tabs}
        selected={tab}
        onSelect={onTab}
        panelId={panelId}
        idPrefix={`${idPrefix}-tab`}
        variant="margin"
      />
      <div role="tabpanel" id={panelId} aria-labelledby={`${idPrefix}-tab-${tab}`}>
        {children}
      </div>
    </>
  );
}

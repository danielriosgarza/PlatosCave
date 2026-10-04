import styles from '../components/Page.module.css';
import local from './Authoring.module.css';

export interface ConflictRow {
  label: string;
  mine: string;
  theirs: string;
}

interface Props {
  what: string;
  rows: ConflictRow[];
  onKeepMine: () => void;
  onUseTheirs: () => void;
}

/**
 * Shown when another editor saved first (§12): both versions side by side and an explicit choice,
 * so nothing is overwritten silently. Only the fields that differ are listed.
 */
export function ConflictView({ what, rows, onKeepMine, onUseTheirs }: Props) {
  return (
    <section className={local.conflict} role="alert" aria-label="Editing conflict">
      <h3 className={styles.subheading}>Someone else changed this {what}</h3>
      <p className={styles.small} style={{ marginTop: 8 }}>
        Your changes are not saved. Choose which version to keep.
      </p>
      {rows.length > 0 ? (
        <dl>
          <dt />
          <dd className={styles.muted}>Yours</dd>
          <dd className={styles.muted}>Theirs</dd>
          {rows.map((r) => (
            <div key={r.label} style={{ display: 'contents' }}>
              <dt>{r.label}</dt>
              <dd>{r.mine || '—'}</dd>
              <dd>{r.theirs || '—'}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className={styles.row}>
        <button type="button" className={styles.primary} onClick={onKeepMine}>
          Keep my version
        </button>
        <button type="button" className={styles.outline} onClick={onUseTheirs}>
          Use their version
        </button>
      </div>
    </section>
  );
}

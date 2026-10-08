import buttons from './Buttons.module.css';
import styles from './ConflictBox.module.css';

interface ConflictBoxProps {
  title: string;
  /** The versions to compare, each shown in full under its label. */
  versions: readonly { label: string; text: string }[];
  keepLabel: string;
  useLabel: string;
  onKeep: () => void;
  onUse: () => void;
}

/** A save refused because the item changed elsewhere: the versions, and an explicit choice (§12). */
export function ConflictBox({
  title,
  versions,
  keepLabel,
  useLabel,
  onKeep,
  onUse,
}: ConflictBoxProps) {
  return (
    <div className={styles.conflict} role="alert">
      <h3>{title}</h3>
      {versions.map((v) => (
        <div key={v.label}>
          <div className={styles.label}>{v.label}</div>
          <pre>{v.text}</pre>
        </div>
      ))}
      <div className={styles.row}>
        <button type="button" className={buttons.outline} onClick={onKeep}>
          {keepLabel}
        </button>
        <button type="button" className={buttons.outline} onClick={onUse}>
          {useLabel}
        </button>
      </div>
    </div>
  );
}

import { useState } from 'react';
import type { Annotation } from '../margin/data';
import styles from '../margin/Margin.module.css';

interface Props {
  annotation: Annotation;
  /** Where it sits, as the reader names it: `Figure 2`, `Page 4`. */
  label: string;
  needsReattachment: boolean;
  /** This sketch is open in the editor. */
  editing: boolean;
  /** Another sketch is open: opening this one would replace its unsaved work. */
  blocked: boolean;
  /** Placed as made; a sketch mapped to a newer revision keeps Download and Delete only. */
  editable: boolean;
  onEdit: () => void;
  onExport: () => void;
  onDelete: () => Promise<boolean>;
}

/** A saved sketch in My notes: its description, and Open, Download SVG and Delete. */
export function SketchEntry({
  annotation,
  label,
  needsReattachment,
  editing,
  blocked,
  editable,
  onEdit,
  onExport,
  onDelete,
}: Props) {
  const [problem, setProblem] = useState(false);
  return (
    <div className={styles.entry} data-active={editing}>
      <div className={styles.entryHead}>
        <span>Sketch · {label}</span>
        <span className={styles.muted}>{needsReattachment ? 'Needs reattachment' : 'Private'}</span>
      </div>
      {annotation.body ? <p className={styles.preview}>{annotation.body}</p> : null}
      <p>
        <button
          type="button"
          className={styles.link}
          disabled={editing || blocked || !editable || needsReattachment}
          onClick={onEdit}
        >
          Open sketch
        </button>{' '}
        <button type="button" className={styles.link} onClick={onExport}>
          Download SVG
        </button>{' '}
        <button
          type="button"
          className={styles.link}
          onClick={async () => setProblem(!(await onDelete()))}
        >
          Delete sketch
        </button>
      </p>
      {problem ? (
        <p role="alert" className={styles.empty}>
          The sketch could not be deleted.
        </p>
      ) : null}
    </div>
  );
}

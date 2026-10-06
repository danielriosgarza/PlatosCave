import { useState } from 'react';
import buttons from '../../components/Buttons.module.css';
import { Dialog } from '../../courses/Dialogs';
import styles from './Files.module.css';
import { copyName, size, where } from './files';

export type Choice = 'keep_theirs' | 'replace' | 'save_copy';

export interface Conflict {
  path: string;
  /** The file found on the computer. */
  remoteSize: number | null;
  /** The file Parallax would write. */
  localSize: number | null;
}

interface Props {
  conflicts: Conflict[];
  host: string | null;
  workspace: string;
  /** Called once every conflict has a choice, in order; nothing is sent before. */
  onResolve: (choices: { path: string; choice: Choice }[]) => void;
  onCancel: () => void;
}

/**
 * A different file already exists where Parallax would write (design §11). Nothing has been
 * written: the person chooses for each file, and Cancel leaves every file as it is.
 */
export function ConflictDialog({ conflicts, host, workspace, onResolve, onCancel }: Props) {
  const [chosen, setChosen] = useState<{ path: string; choice: Choice }[]>([]);
  const current = conflicts[chosen.length];
  if (!current) return null;
  const choose = (choice: Choice) => {
    const next = [...chosen, { path: current.path, choice }];
    if (next.length === conflicts.length) onResolve(next);
    else setChosen(next);
  };
  const sizes = (n: number | null) => (n === null ? 'size unknown' : size(n));
  return (
    <Dialog title={`${current.path} already exists`} onClose={onCancel}>
      <div className={styles.dialogBody}>
        <p>
          A different file named <code>{current.path}</code> is already in <code>{workspace}</code>{' '}
          on {where(host)} ({sizes(current.remoteSize)}). Yours is {sizes(current.localSize)}.
          Nothing has been written.
        </p>
        {conflicts.length > 1 ? (
          <p className={styles.note}>
            File {chosen.length + 1} of {conflicts.length}
          </p>
        ) : null}
        <div className={styles.choices}>
          <button type="button" className={buttons.outline} onClick={() => choose('keep_theirs')}>
            Keep theirs
          </button>
          <button type="button" className={buttons.outline} onClick={() => choose('replace')}>
            Replace with mine
          </button>
          <button type="button" className={buttons.outline} onClick={() => choose('save_copy')}>
            Save mine as {copyName(current.path)}
          </button>
        </div>
        <button type="button" className={buttons.textButton} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}

import type { OpenResource } from '@parallax/contracts';
import { useState } from 'react';
import buttons from '../components/Buttons.module.css';
import styles from '../notebooks/Notebook.module.css';
import { NotebookView } from '../notebooks/NotebookView';
import { ResourceTools } from '../workspace/ResourceTools';
import { OpenColab } from './OpenColab';

/**
 * A notebook on the Notebooks tab at level 0 (docs/design/open-site.md §6): `NotebookView` with the
 * outputs it was stored with, a plain link to its file without outputs, and the Colab route.
 * Nothing connects, runs or is handed in, and no `OutputSourceLink` is provided, so no output
 * offers the original notebook.
 */
export function NotebooksPanel({ file, notebook }: Extract<OpenResource, { type: 'notebook' }>) {
  const [showCode, setShowCode] = useState(true);
  const [showOutputs, setShowOutputs] = useState(true);
  const [outlineOpen, setOutlineOpen] = useState(false);
  return (
    <>
      <ResourceTools>
        {/* The outputs the notebook file was stored with: no computer is connected here. */}
        <span className={styles.mode}>Saved outputs</span>
        {notebook.outline.length > 0 ? (
          <button
            type="button"
            className={buttons.tool}
            aria-expanded={outlineOpen}
            onClick={() => setOutlineOpen(!outlineOpen)}
          >
            Outline
          </button>
        ) : null}
        <button type="button" className={buttons.tool} onClick={() => setShowCode(!showCode)}>
          {showCode ? 'Hide code' : 'Show code'}
        </button>
        <button type="button" className={buttons.tool} onClick={() => setShowOutputs(!showOutputs)}>
          {showOutputs ? 'Hide outputs' : 'Show outputs'}
        </button>
        <a className={buttons.tool} href={file}>
          Download notebook without outputs
        </a>
      </ResourceTools>
      <div className={styles.stage}>
        <NotebookView {...{ notebook, showCode, showOutputs, outlineOpen }} />
        <OpenColab file={file} />
      </div>
    </>
  );
}

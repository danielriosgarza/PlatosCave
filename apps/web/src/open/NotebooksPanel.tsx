import type { OpenResource } from '@parallax/contracts';
import { useRef, useState } from 'react';
import buttons from '../components/Buttons.module.css';
import styles from '../notebooks/Notebook.module.css';
import { NotebookView } from '../notebooks/NotebookView';
import { ResourceTools } from '../workspace/ResourceTools';
import { ConnectThisComputer, OpenLiveNotebook } from './local/OpenRun';
import { type LocalRun, runOf } from './local/session';
import { OpenColab } from './OpenColab';
import { OpenLocal } from './OpenLocal';

/**
 * A notebook on the Notebooks tab at level 0 (docs/design/open-site.md §6): `NotebookView` with the
 * outputs it was stored with, a plain link to its file without outputs, the way to work on one's
 * own computer, and the Colab route. **Run on this computer** connects the page to the connector's
 * open mode on the visitor's computer (§14): the cells then run there and their outputs return to
 * this page. Nothing is saved on the site or handed in, and no `OutputSourceLink` is provided, so
 * no output offers the original notebook.
 */
export function NotebooksPanel({
  address,
  folder,
  file,
  data,
  notebook,
}: Extract<OpenResource, { type: 'notebook' }> & {
  /** The data file's address: the page keeps the notebook's run on this computer under it. */
  address: string;
  /** The notebook's folder on this computer, below the site's. */
  folder: string[];
}) {
  const [showCode, setShowCode] = useState(true);
  const [showOutputs, setShowOutputs] = useState(true);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [run, setRun] = useState<LocalRun | null>(() => runOf(address) ?? null);
  // Edits are the page's own: they stay while the page is open, whatever runs them.
  const [sources, setSources] = useState<Record<string, string>>({});
  const runButton = useRef<HTMLButtonElement>(null);

  const trail = (
    <>
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
    </>
  );

  if (run) {
    return (
      <div className={styles.stage}>
        <OpenLiveNotebook
          address={address}
          run={run}
          notebook={notebook}
          outlineOpen={outlineOpen}
          showCode={showCode}
          showOutputs={showOutputs}
          sources={sources}
          onEdit={(cellId, value) => setSources((all) => ({ ...all, [cellId]: value }))}
          trail={trail}
          onEnded={() => setRun(null)}
        />
      </div>
    );
  }
  return (
    <>
      <ResourceTools>
        {/* The outputs the notebook file was stored with: no computer is connected here. */}
        <span className={styles.mode}>Saved outputs</span>
        <button
          type="button"
          ref={runButton}
          className={buttons.tool}
          aria-expanded={connectOpen}
          aria-controls="run-local-panel"
          onClick={() => setConnectOpen(!connectOpen)}
        >
          Run on this computer
        </button>
        {trail}
      </ResourceTools>
      {connectOpen ? (
        <div id="run-local-panel">
          <ConnectThisComputer
            notebook={address}
            folder={folder}
            data={data}
            kernel={notebook.kernel}
            language={notebook.language}
            onConnected={(started) => {
              setConnectOpen(false);
              setRun(started);
            }}
            onClose={() => {
              setConnectOpen(false);
              runButton.current?.focus();
            }}
          />
        </div>
      ) : null}
      <div className={styles.stage}>
        <NotebookView {...{ notebook, showCode, showOutputs, outlineOpen }} />
        <OpenLocal file={file} data={data} language={notebook.language} />
        <OpenColab file={file} />
      </div>
    </>
  );
}

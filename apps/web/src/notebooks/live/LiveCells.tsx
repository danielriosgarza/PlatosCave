import { type ReactNode, type RefObject, useState } from 'react';
import buttons from '../../components/Buttons.module.css';
import readingStyles from '../../reading/Reading.module.css';
import { codeText } from '../connect/messages';
import styles from '../Notebook.module.css';
import { Markdown, Outline, Output } from '../NotebookView';
import type { Notebook } from '../notebooks';
import { CellEditor } from './CellEditor';
import type { LiveExecution, LiveState } from './executionState';
import live from './Live.module.css';
import { LiveOutputs, type RichItem } from './Outputs';

interface Props {
  notebook: Notebook;
  root: RefObject<HTMLElement | null>;
  /** Notices shown above the cells. */
  banner: ReactNode;
  outlineOpen: boolean;
  showCode: boolean;
  showOutputs: boolean;
  /** The person's edits by cell id. */
  sources: Record<string, string>;
  onEdit: (cellId: string, value: string) => void;
  /** The latest execution of each cell. */
  latest: Record<string, LiveExecution>;
  refusals: LiveState['refusals'];
  kernelGeneration: number | undefined;
  /** A cell can be run now (not while Run all goes through the notebook). */
  canRun: boolean;
  runCell: (cellId: string) => void;
  onInputReply: (executionId: string, value: string) => boolean;
  renderRich: (item: RichItem) => ReactNode;
}

/**
 * The cells of a live notebook, at level 1 (`LiveNotebook`) and at level 0 (`OpenLiveNotebook`):
 * Markdown as stored, code in an editor with Run, and each cell's latest execution, or its stored
 * output until it has run.
 */
export function LiveCells({
  notebook,
  root,
  banner,
  outlineOpen,
  showCode,
  showOutputs,
  sources,
  onEdit,
  latest,
  refusals,
  kernelGeneration,
  canRun,
  runCell,
  onInputReply,
  renderRich,
}: Props) {
  // Cells opened one by one; a change of the toolbar's Show/Hide resets them.
  const [opened, setOpened] = useState<{
    code: boolean;
    outputs: boolean;
    cells: Record<string, { code?: boolean; output?: boolean }>;
  }>({ code: showCode, outputs: showOutputs, cells: {} });
  const revealed = opened.code === showCode && opened.outputs === showOutputs ? opened.cells : {};
  const reveal = (id: string, part: 'code' | 'output') =>
    setOpened({
      code: showCode,
      outputs: showOutputs,
      cells: { ...revealed, [id]: { ...revealed[id], [part]: true } },
    });

  return (
    <article ref={root} className={styles.notebook} aria-label="Live notebook">
      {banner}
      {outlineOpen ? <Outline notebook={notebook} root={root} /> : null}
      {notebook.cells.map((cell, index) => {
        if (cell.type === 'markdown') {
          return (
            <section key={cell.id} data-cell-id={cell.id} tabIndex={-1}>
              <Markdown html={cell.html} className={`${styles.prose} ${readingStyles.native}`} />
            </section>
          );
        }
        if (cell.type === 'raw') {
          return (
            <section key={cell.id} data-cell-id={cell.id} tabIndex={-1} className={styles.cell}>
              <span className={styles.num} />
              <pre className={styles.raw}>{cell.text}</pre>
            </section>
          );
        }
        const execution: LiveExecution | undefined = latest[cell.id];
        const count = execution?.executionCount ?? cell.executionCount;
        const marker = `[${count ?? ' '}]`;
        // Cells that have not run share a marker, so their names carry their position.
        const name = `${index + 1} ${marker}`;
        const codeHidden = (!showCode || cell.sourceHidden) && !revealed[cell.id]?.code;
        const outputHidden = (!showOutputs || cell.outputsHidden) && !revealed[cell.id]?.output;
        return (
          <section
            key={cell.id}
            data-cell-id={cell.id}
            tabIndex={-1}
            aria-label={`Code cell ${name}`}
          >
            <div className={styles.cell}>
              <span className={styles.num}>{marker}</span>
              <div className={live.cellEditor}>
                {codeHidden ? (
                  <button
                    type="button"
                    className={buttons.textButton}
                    aria-label={`Show code of cell ${name}`}
                    onClick={() => reveal(cell.id, 'code')}
                  >
                    Show code
                  </button>
                ) : (
                  <CellEditor
                    label={`Code of cell ${name}`}
                    value={sources[cell.id] ?? cell.source}
                    onChange={(value) => onEdit(cell.id, value)}
                    onRun={() => canRun && runCell(cell.id)}
                  />
                )}
                <div className={live.cellTools}>
                  <button
                    type="button"
                    className={buttons.tool}
                    aria-label={`Run cell ${name}`}
                    disabled={!canRun}
                    onClick={() => runCell(cell.id)}
                  >
                    Run
                  </button>
                  {refusals[cell.id] ? (
                    <span className={live.refusal} role="alert">
                      {codeText(refusals[cell.id]?.code)}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
            {outputHidden && (execution || cell.outputs.length > 0) ? (
              <div className={styles.cell}>
                <span className={styles.num}>Out</span>
                <div>
                  <button
                    type="button"
                    className={buttons.textButton}
                    aria-label={`Show output of cell ${name}`}
                    onClick={() => reveal(cell.id, 'output')}
                  >
                    Show output
                  </button>
                </div>
              </div>
            ) : execution ? (
              <div className={styles.cell}>
                <span className={styles.num}>Out</span>
                <LiveOutputs
                  execution={execution}
                  renderRich={renderRich}
                  kernelGeneration={kernelGeneration}
                  canRun={canRun}
                  onRunAgain={() => {
                    if (canRun) runCell(cell.id);
                  }}
                  onInputReply={(value) => onInputReply(execution.executionId, value)}
                />
              </div>
            ) : cell.outputs.length > 0 ? (
              <div className={styles.cell}>
                <span className={styles.num}>Out</span>
                <div className={styles.outputs}>
                  {cell.outputs.map((output, i) => (
                    // Stored outputs never move: their order is their identity.
                    // biome-ignore lint/suspicious/noArrayIndexKey: see above
                    <Output key={i} output={output} cellCount={cell.executionCount} />
                  ))}
                  <div className={styles.provenance}>
                    Stored output · {notebook.kernel ?? 'kernel not recorded'}
                  </div>
                </div>
              </div>
            ) : null}
          </section>
        );
      })}
    </article>
  );
}

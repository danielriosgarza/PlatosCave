import { useMemo, useRef, useState } from 'react';
import buttons from '../components/Buttons.module.css';
import readingStyles from '../reading/Reading.module.css';
import { sanitizeReading } from '../reading/sanitize';
import styles from './Notebook.module.css';
import type { CellOutput, Notebook, NotebookCell } from './notebooks';

interface Props {
  notebook: Notebook;
  /** Source of code cells shown (the notebook's own collapsed cells stay collapsed). */
  showCode: boolean;
  showOutputs: boolean;
  outlineOpen: boolean;
}

type Shown = Record<string, { code?: boolean; output?: boolean }>;

/**
 * A rendered notebook (§10.1, §10.7): Markdown, code with execution counts, and the outputs the
 * file stored, each group labelled with the kernel that produced it. Nothing runs here. Markdown
 * is sanitised again before insertion; HTML outputs are documents on the content origin, framed
 * with every sandbox restriction.
 */
export function NotebookView({ notebook, showCode, showOutputs, outlineOpen }: Props) {
  const root = useRef<HTMLElement | null>(null);
  // Cells opened one by one; a change of the toolbar's Show/Hide resets them.
  const [shown, setShown] = useState<{ code: boolean; outputs: boolean; cells: Shown }>({
    code: showCode,
    outputs: showOutputs,
    cells: {},
  });
  const cells = shown.code === showCode && shown.outputs === showOutputs ? shown.cells : {};
  const reveal = (id: string, part: 'code' | 'output') =>
    setShown({
      code: showCode,
      outputs: showOutputs,
      cells: { ...cells, [id]: { ...cells[id], [part]: true } },
    });

  return (
    <article ref={root} className={styles.notebook}>
      {outlineOpen ? <Outline notebook={notebook} root={root} /> : null}
      {notebook.cells.map((cell) => (
        <Cell
          key={cell.id}
          cell={cell}
          kernel={notebook.kernel}
          codeShown={
            cells[cell.id]?.code ?? (showCode && !(cell.type === 'code' && cell.sourceHidden))
          }
          outputShown={
            cells[cell.id]?.output ?? (showOutputs && !(cell.type === 'code' && cell.outputsHidden))
          }
          onReveal={(part) => reveal(cell.id, part)}
        />
      ))}
    </article>
  );
}

/** The notebook's headings as links that scroll to and focus their cell. */
export function Outline({
  notebook,
  root,
}: {
  notebook: Notebook;
  root: { current: HTMLElement | null };
}) {
  const goTo = (cellId: string) => {
    const target = root.current?.querySelector<HTMLElement>(
      `[data-cell-id="${CSS.escape(cellId)}"]`,
    );
    target?.scrollIntoView({ block: 'start' });
    target?.focus({ preventScroll: true });
  };
  if (notebook.outline.length === 0) return null;
  return (
    <nav className={styles.toc} aria-label="Notebook outline">
      <div className={styles.label}>Outline</div>
      <ol>
        {notebook.outline.map((h, i) => (
          // A cell may hold several headings; the outline never reorders.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <li key={i} data-level={h.level}>
            <button type="button" onClick={() => goTo(h.cellId)}>
              {h.text}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function Markdown({ html, className }: { html: string; className: string }) {
  const clean = useMemo(() => sanitizeReading(html), [html]);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitised at import and again just above
  return <div className={className} dangerouslySetInnerHTML={{ __html: clean }} />;
}

const count = (n: number | null) => `[${n ?? ' '}]`;

function Cell({
  cell,
  kernel,
  codeShown,
  outputShown,
  onReveal,
}: {
  cell: NotebookCell;
  kernel: string | null;
  codeShown: boolean;
  outputShown: boolean;
  onReveal: (part: 'code' | 'output') => void;
}) {
  if (cell.type === 'markdown') {
    return (
      <section data-cell-id={cell.id} tabIndex={-1}>
        <Markdown html={cell.html} className={`${styles.prose} ${readingStyles.native}`} />
      </section>
    );
  }
  if (cell.type === 'raw') {
    return (
      <section data-cell-id={cell.id} tabIndex={-1} className={styles.cell}>
        <span className={styles.num} />
        <pre className={styles.raw}>{cell.text}</pre>
      </section>
    );
  }
  return (
    <section
      data-cell-id={cell.id}
      tabIndex={-1}
      aria-label={`Code cell ${count(cell.executionCount)}`}
    >
      <div className={styles.cell}>
        <span className={styles.num}>{count(cell.executionCount)}</span>
        {codeShown ? (
          <pre className={styles.code}>
            <code>{cell.source}</code>
          </pre>
        ) : (
          <div>
            <button
              type="button"
              className={buttons.textButton}
              aria-label={`Show code of cell ${count(cell.executionCount)}`}
              onClick={() => onReveal('code')}
            >
              Show code
            </button>
          </div>
        )}
      </div>
      {cell.outputs.length > 0 ? (
        <div className={styles.cell}>
          <span className={styles.num}>Out</span>
          {outputShown ? (
            <div className={styles.outputs}>
              {cell.outputs.map((output, i) => (
                // Outputs never move within a stored cell: their order is their identity.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above
                <Output key={i} output={output} cellCount={cell.executionCount} />
              ))}
              <div className={styles.provenance}>
                Stored output · {kernel ?? 'kernel not recorded'}
              </div>
            </div>
          ) : (
            <div>
              <button
                type="button"
                className={buttons.textButton}
                aria-label={`Show output of cell ${count(cell.executionCount)}`}
                onClick={() => onReveal('output')}
              >
                Show output
              </button>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

export function Output({ output, cellCount }: { output: CellOutput; cellCount: number | null }) {
  switch (output.type) {
    case 'text':
      return (
        <div className={styles.output}>
          <pre className={`${styles.text} ${output.stream === 'stderr' ? styles.stderr : ''}`}>
            {output.text}
          </pre>
          {output.truncated ? <div className={styles.provenance}>Output truncated</div> : null}
        </div>
      );
    case 'error':
      return (
        <div className={styles.output}>
          <div className={styles.error}>
            <div className={styles.errorName}>
              {output.name}: {output.value}
            </div>
            {output.traceback ? <pre className={styles.text}>{output.traceback}</pre> : null}
          </div>
          {output.truncated ? <div className={styles.provenance}>Output truncated</div> : null}
        </div>
      );
    case 'image':
      return (
        <div className={styles.output}>
          {output.url ? (
            <img className={styles.image} src={output.url} alt={output.alt} />
          ) : (
            <p>{output.alt} (image unavailable)</p>
          )}
        </div>
      );
    case 'table':
      return (
        <div className={styles.output}>
          <table className={styles.table}>
            {output.caption ? <caption>{output.caption}</caption> : null}
            {output.head.length > 0 ? (
              <thead>
                {output.head.map((row, r) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: stored rows never reorder
                  <TableRow key={r} row={row} />
                ))}
              </thead>
            ) : null}
            <tbody>
              {output.body.map((row, r) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: stored rows never reorder
                <TableRow key={r} row={row} />
              ))}
            </tbody>
          </table>
          {output.notes.map((note, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: stored notes never reorder
            <div key={i} className={styles.provenance}>
              {note}
            </div>
          ))}
        </div>
      );
    case 'html':
      return (
        <div className={styles.output}>
          {output.url ? (
            <div className={styles.frameBox} style={{ height: output.height }}>
              <iframe
                className={styles.frame}
                // Every sandbox restriction: no script, no same origin, no forms, popups or
                // navigation of this page. The content origin's own CSP says the same.
                sandbox=""
                src={output.url}
                title={`Output of cell ${count(cellCount)}`}
                referrerPolicy="no-referrer"
                loading="lazy"
              />
            </div>
          ) : (
            <p>This output is unavailable.</p>
          )}
          {output.scriptsRemoved ? (
            <div className={styles.provenance}>Scripts in this output were removed and not run</div>
          ) : null}
        </div>
      );
    case 'markdown':
      return (
        <div className={styles.output}>
          <Markdown html={output.html} className={readingStyles.native ?? ''} />
        </div>
      );
    case 'unsupported':
      return (
        <div className={styles.output}>
          <p className={styles.label}>
            Interactive output not shown ({output.mimeTypes.join(', ')})
          </p>
        </div>
      );
  }
}

function TableRow({ row }: { row: Extract<CellOutput, { type: 'table' }>['body'][number] }) {
  return (
    <tr>
      {row.map((cell, c) => {
        const Tag = cell.header ? 'th' : 'td';
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: stored cells never reorder
          <Tag key={c} colSpan={cell.colSpan} rowSpan={cell.rowSpan}>
            {cell.text}
          </Tag>
        );
      })}
    </tr>
  );
}

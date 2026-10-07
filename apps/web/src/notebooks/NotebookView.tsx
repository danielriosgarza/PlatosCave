import { createContext, type ReactNode, useContext, useMemo, useRef, useState } from 'react';
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

/**
 * Fetches the notebook again, which mints new output links. Provided by the page that owns the
 * notebook query; a stored image whose link no longer loads offers it as Try again.
 */
export const RenewOutputLinks = createContext<(() => void) | null>(null);

/**
 * The notebook's source download, shown beside a notice that sanitisation removed or did not show
 * an output (§10.7), so the original stays reachable from the output itself.
 */
export const OutputSourceLink = createContext<ReactNode>(null);

type Shown = Record<string, { code?: boolean; output?: boolean }>;

/**
 * A rendered notebook (§10.1, §10.7): Markdown, code with execution counts, and the outputs the
 * file stored, each group labelled with the kernel that produced it. Nothing runs here. Markdown
 * is sanitised again before insertion; HTML outputs are documents on the content origin, framed
 * with every sandbox restriction.
 */
export function NotebookView({ notebook, showCode, showOutputs, outlineOpen }: Props) {
  const root = useRef<HTMLElement | null>(null);
  // Cells opened or collapsed one by one; a change of the toolbar's Show/Hide resets them.
  const [shown, setShown] = useState<{ code: boolean; outputs: boolean; cells: Shown }>({
    code: showCode,
    outputs: showOutputs,
    cells: {},
  });
  const cells = shown.code === showCode && shown.outputs === showOutputs ? shown.cells : {};
  const setPart = (id: string, part: 'code' | 'output', open: boolean) =>
    setShown({
      code: showCode,
      outputs: showOutputs,
      cells: { ...cells, [id]: { ...cells[id], [part]: open } },
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
          onToggle={(part, open) => setPart(cell.id, part, open)}
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
  onToggle,
}: {
  cell: NotebookCell;
  kernel: string | null;
  codeShown: boolean;
  outputShown: boolean;
  onToggle: (part: 'code' | 'output', open: boolean) => void;
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
        <div className={styles.cellBody}>
          <CellToggle
            part="code"
            open={codeShown}
            cellCount={cell.executionCount}
            onToggle={(open) => onToggle('code', open)}
          />
          {codeShown ? (
            <pre className={styles.code}>
              <code>{cell.source}</code>
            </pre>
          ) : null}
        </div>
      </div>
      {cell.outputs.length > 0 ? (
        <div className={styles.cell}>
          <span className={styles.num}>Out</span>
          <div className={styles.cellBody}>
            <CellToggle
              part="output"
              open={outputShown}
              cellCount={cell.executionCount}
              onToggle={(open) => onToggle('output', open)}
            />
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
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Collapses or shows one part of a code cell, whatever the toolbar last set. */
function CellToggle({
  part,
  open,
  cellCount,
  onToggle,
}: {
  part: 'code' | 'output';
  open: boolean;
  cellCount: number | null;
  onToggle: (open: boolean) => void;
}) {
  const verb = open ? 'Collapse' : 'Show';
  return (
    <div>
      <button
        type="button"
        className={buttons.textButton}
        aria-expanded={open}
        aria-label={`${verb} ${part} of cell ${count(cellCount)}`}
        onClick={() => onToggle(!open)}
      >
        {verb} {part === 'code' ? 'source' : 'output'}
      </button>
    </div>
  );
}

/** A provenance notice for an output that sanitisation removed or left out, with the source link. */
function RemovedNotice({ children }: { children: ReactNode }) {
  return (
    <div className={styles.provenance}>
      <span>{children}</span>
      <SourceLink />
    </div>
  );
}

function SourceLink() {
  const source = useContext(OutputSourceLink);
  return source ? <> · Original notebook: {source}</> : null;
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
            <StoredImage url={output.url} alt={output.alt} />
          ) : (
            <p>{output.alt} (image unavailable)</p>
          )}
          {output.scriptsRemoved ? (
            <RemovedNotice>Scripts in this output were removed and not run</RemovedNotice>
          ) : null}
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
              <StoredFrame url={output.url} title={`Output of cell ${count(cellCount)}`} />
            </div>
          ) : (
            <p>This output is unavailable.</p>
          )}
          {output.scriptsRemoved ? (
            <RemovedNotice>Scripts in this output were removed and not run</RemovedNotice>
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
            <span>Interactive output not shown ({output.mimeTypes.join(', ')})</span>
            <SourceLink />
          </p>
        </div>
      );
  }
}

/**
 * The link an element was first loaded from stays its `src`: a renewed link only serves elements
 * that have not loaded yet, so renewal never downloads a stored output again.
 */
function useLoadedLink(url: string) {
  const [loaded, setLoaded] = useState<string | null>(null);
  return { src: loaded ?? url, onLoad: () => setLoaded((was) => was ?? url) };
}

function StoredImage({ url, alt }: { url: string; alt: string }) {
  const renew = useContext(RenewOutputLinks);
  const link = useLoadedLink(url);
  // The link that failed to load; a new link, or Try again, shows the image again.
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  if (link.src === brokenUrl) {
    return (
      <p role="status">
        This image could not be loaded.{' '}
        {renew ? (
          <button
            type="button"
            className={buttons.textButton}
            onClick={() => {
              setBrokenUrl(null);
              renew();
            }}
          >
            Try again
          </button>
        ) : null}
        <span className={styles.provenance}> {alt}</span>
      </p>
    );
  }
  return (
    <img
      className={styles.image}
      src={link.src}
      alt={alt}
      referrerPolicy="no-referrer"
      onLoad={link.onLoad}
      onError={() => setBrokenUrl(link.src)}
    />
  );
}

function StoredFrame({ url, title }: { url: string; title: string }) {
  const link = useLoadedLink(url);
  return (
    <iframe
      className={styles.frame}
      // Every sandbox restriction: no script, no same origin, no forms, popups or
      // navigation of this page. The content origin's own CSP says the same.
      sandbox=""
      src={link.src}
      title={title}
      referrerPolicy="no-referrer"
      // Lazy is safe: the notebook is refetched before its links lapse, so a frame created
      // late is given a link that is at most four minutes old.
      loading="lazy"
      onLoad={link.onLoad}
    />
  );
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

import type { NotebookView, OpenNotebookFile } from '@parallax/contracts';

/**
 * The notebook file a visitor downloads (docs/design/open-site.md §3), composed from the rendered
 * view and not from the notebook's own `.ipynb`: a Markdown cell holds its sanitised rendered
 * HTML, a raw cell its text, and a code cell its source with no execution count and no outputs.
 * Each cell keeps its id, and `metadata` holds the language name and nothing else. So the file has
 * no stored output, attachment or other metadata, a JavaScript payload included. The build writes
 * `openNotebookFile.parse` of the result as an object, never under `site/`.
 */
export function notebookDownload(view: NotebookView): OpenNotebookFile {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: view.language === null ? {} : { language_info: { name: view.language } },
    cells: view.cells.map((cell) => {
      const { id } = cell;
      if (cell.type === 'markdown') {
        return { id, metadata: {}, cell_type: 'markdown', source: cell.html };
      }
      if (cell.type === 'raw') return { id, metadata: {}, cell_type: 'raw', source: cell.text };
      const { source } = cell;
      return { id, metadata: {}, cell_type: 'code', source, execution_count: null, outputs: [] };
    }),
  };
}

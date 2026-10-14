import type { NotebookView, OpenNotebookFile } from '@parallax/contracts';

/**
 * The notebook file a visitor downloads (docs/design/open-site.md §3), composed from the rendered
 * view and not from the notebook's own `.ipynb`: a Markdown cell holds the view's sanitised
 * rendered HTML unchanged, the string the notebook's data file carries, with the image addresses
 * on the content origin that `resolveReadingImages` set; a raw cell holds its text, and a code
 * cell its source with no execution count and no outputs. `metadata` holds the language name and
 * nothing else. So the file has no stored output, attachment or other metadata, a JavaScript
 * payload included. The build writes `openNotebookFile.parse` of the result as an object, never
 * under `site/`.
 *
 * Each cell keeps its id unless an earlier cell has it: nbformat 4.5 wants them unique, which
 * `openNotebookFile` does not check and `parseNotebook` does. The renderer gives unique ids; a view
 * stored otherwise gets `cell-<index>`, as the renderer numbers, or `cell-<index>-<n>` if that is
 * taken too, both nbformat ids.
 */
export function notebookDownload(view: NotebookView): OpenNotebookFile {
  const used = new Set<string>();
  const unique = (given: string, index: number) => {
    let id = used.has(given) ? `cell-${index}` : given;
    for (let n = 2; used.has(id); n += 1) id = `cell-${index}-${n}`;
    used.add(id);
    return id;
  };
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: view.language === null ? {} : { language_info: { name: view.language } },
    cells: view.cells.map((cell, index) => {
      const id = unique(cell.id, index);
      if (cell.type === 'markdown') {
        return { id, metadata: {}, cell_type: 'markdown', source: cell.html };
      }
      if (cell.type === 'raw') return { id, metadata: {}, cell_type: 'raw', source: cell.text };
      const { source } = cell;
      return { id, metadata: {}, cell_type: 'code', source, execution_count: null, outputs: [] };
    }),
  };
}

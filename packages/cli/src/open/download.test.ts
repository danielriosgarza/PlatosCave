import type { NotebookView } from '@parallax/contracts';
import { expect, test } from 'vitest';
import { loadSource } from '../paths';
import { notebookDownload } from './download';

delete process.env.DATABASE_URL;
type Contracts = typeof import('@parallax/contracts');
const contracts = await loadSource<Contracts>('contracts', 'src/index.ts');
const { notebookView, openNotebookFile, parseNotebook } = contracts;

/** Stands in the stored outputs only: in a stream, an alt text, a type name and an address. */
const MARKER = 'only-in-an-output';
const object = (name: string) => `https://content.example.org/o/${name}`;
const figure = `<figure><img alt="Transect" src="${object('aa.png')}"></figure>`;
const none = { executionCount: null };
const outputs = [
  { type: 'text', executionCount: 3, stream: null, text: `12.0 ${MARKER}`, truncated: false },
  { ...none, type: 'image', url: object(`${MARKER}.png`), alt: MARKER },
  { ...none, type: 'html', url: object(`${MARKER}.html`), height: 80, scriptsRemoved: true },
  { ...none, type: 'unsupported', mimeTypes: ['application/javascript', MARKER] },
];
const shown = { executionCount: 3, sourceHidden: true, outputsHidden: false };
const view: NotebookView = notebookView.parse({
  kernel: 'Python 3',
  language: 'python',
  outline: [{ cellId: 'intro', level: 1, text: 'Counts' }],
  cells: [
    { id: 'intro', type: 'markdown', html: `<h1>Counts</h1>${figure}` },
    { id: 'note', type: 'raw', text: 'Counted at low tide.' },
    { ...shown, id: 'draw', type: 'code', source: 'counts.mean()', outputs: outputs.slice(0, 2) },
    { ...shown, id: 'cell-3-1', type: 'code', source: 'show(table)', outputs: outputs.slice(2) },
  ],
});

test('the notebook file for download is composed from the rendered view, without outputs', () => {
  const file = notebookDownload(view);
  const text = JSON.stringify(file);
  expect(openNotebookFile.parse(file)).toEqual(file);
  expect(parseNotebook(text)).toMatchObject({ ok: true });
  const unrun = { metadata: {}, cell_type: 'code', execution_count: null, outputs: [] };
  expect(file).toEqual({
    nbformat: 4,
    nbformat_minor: 5,
    // The language name and nothing else: no kernel, no other metadata.
    metadata: { language_info: { name: 'python' } },
    cells: [
      // The rendered HTML, whose image is on the content origin.
      { id: 'intro', metadata: {}, cell_type: 'markdown', source: `<h1>Counts</h1>${figure}` },
      { id: 'note', metadata: {}, cell_type: 'raw', source: 'Counted at low tide.' },
      { ...unrun, id: 'draw', source: 'counts.mean()' },
      { ...unrun, id: 'cell-3-1', source: 'show(table)' },
    ],
  });
  expect(JSON.stringify(view).split(MARKER)).toHaveLength(6);
  expect(text).not.toContain(MARKER);
});

test('a view without a language gives empty metadata, and the cell ids are those of the view', () => {
  const file = notebookDownload({ ...view, language: null });
  expect(file.metadata).toEqual({});
  expect(parseNotebook(JSON.stringify(file)).ok).toBe(true);
  // The renderer makes ids unique; the notebook contract is what refuses a view that does not.
  const twice = notebookDownload({ ...view, cells: [...view.cells, ...view.cells.slice(0, 1)] });
  expect(parseNotebook(JSON.stringify(twice))).toMatchObject({ ok: false });
});

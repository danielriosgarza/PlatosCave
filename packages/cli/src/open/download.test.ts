import type { StoredNotebook } from '@parallax/contracts';
import { expect, test } from 'vitest';
import { loadSource } from '../paths';
import { notebookDownload } from './download';

delete process.env.DATABASE_URL;
type Contracts = typeof import('@parallax/contracts');
const contracts = await loadSource<Contracts>('contracts', 'src/index.ts');
const { openNotebookFile, parseNotebook, storedNotebook, viewNotebook } = contracts;
type UrlFor = (key: string) => string | null;
type Reading = { resolveReadingImages(html: string, urlFor: UrlFor): string };
const { resolveReadingImages } = await loadSource<Reading>('server', 'src/content/reading.ts');

/** Stands in the stored outputs only: in a result's text, an alt text, a type and two addresses. */
const MARKER = 'only-in-an-output';
const CONTENT = 'https://content.example.org';
/** The build's `urlFor`: an object's address on the content origin, named by its key. */
const urlFor = (key: string) => `${CONTENT}/o/${key.replace('open/objects/', '')}.png`;
const FIGURE = 'a1'.repeat(32);
const none = { executionCount: null };
const outputs = [
  { type: 'text', executionCount: 3, stream: null, text: `12.0 ${MARKER}`, truncated: false },
  { ...none, type: 'image', key: `open/objects/${MARKER}`, contentType: 'image/png', alt: MARKER },
  { ...none, type: 'html', key: `open/objects/${MARKER}`, height: 80, scriptsRemoved: true },
  { ...none, type: 'unsupported', mimeTypes: ['application/javascript', MARKER] },
];
const shown = { executionCount: 3, sourceHidden: true, outputsHidden: false };
/** A notebook as conversion stores it: the Markdown cell's image has a key and no address yet. */
const stored: StoredNotebook = storedNotebook.parse({
  kernel: 'Python 3',
  language: 'python',
  outline: [{ cellId: 'intro', level: 1, text: 'Counts' }],
  cells: [
    {
      id: 'intro',
      type: 'markdown',
      html: `<h1>Counts</h1><p><img alt="Transect" data-object-key="open/objects/${FIGURE}"></p>`,
    },
    { id: 'note', type: 'raw', text: 'Counted at low tide.' },
    { ...shown, id: 'draw', type: 'code', source: 'counts.mean()', outputs: outputs.slice(0, 2) },
    { ...shown, id: 'cell-3-1', type: 'code', source: 'show(table)', outputs: outputs.slice(2) },
  ],
});
/** The rendered view, as the build makes it: `viewNotebook` with the server's image step. */
const viewOf = (notebook: StoredNotebook) => viewNotebook(notebook, urlFor, resolveReadingImages);
const view = viewOf(stored);

test('the notebook file for download is composed from the rendered view, without outputs', () => {
  const file = notebookDownload(view);
  const text = JSON.stringify(file);
  expect(openNotebookFile.parse(file)).toEqual(file);
  expect(parseNotebook(text)).toMatchObject({ ok: true });
  const [intro] = view.cells;
  if (intro?.type !== 'markdown') throw new Error('the view starts with a Markdown cell');
  const unrun = { metadata: {}, cell_type: 'code', execution_count: null, outputs: [] };
  expect(file).toEqual({
    nbformat: 4,
    nbformat_minor: 5,
    // The language name and nothing else: no kernel, no other metadata.
    metadata: { language_info: { name: 'python' } },
    cells: [
      // The rendered HTML as it is: the view's, which the notebook's data file carries too.
      { id: 'intro', metadata: {}, cell_type: 'markdown', source: intro.html },
      { id: 'note', metadata: {}, cell_type: 'raw', source: 'Counted at low tide.' },
      { ...unrun, id: 'draw', source: 'counts.mean()' },
      { ...unrun, id: 'cell-3-1', source: 'show(table)' },
    ],
  });
  expect(JSON.stringify(view).split(MARKER)).toHaveLength(6);
  expect(text).not.toContain(MARKER);
  expect(notebookDownload({ ...view, language: null }).metadata).toEqual({});
});

test('the Markdown cell holds its rendered HTML, whose image address is on the content origin', () => {
  // The audit of output.ts reads no file under content/: this is the check of these addresses.
  const markdown = notebookDownload(view).cells.filter((cell) => cell.cell_type === 'markdown');
  const sources = markdown.map(({ source }) => source);
  const addresses = sources.flatMap((html) => [...html.matchAll(/\ssrc="([^"]*)"/g)]);
  expect(addresses.map(([, address]) => address)).toEqual([`${CONTENT}/o/${FIGURE}.png`]);
  expect(sources.join('')).toContain('<h1>Counts</h1>');
});

test('cells of a stored view that start from the same id get ids of their own', () => {
  const [intro, note, draw] = stored.cells;
  if (!intro || !note || !draw) throw new Error('the stored notebook has three cells first');
  // The second `draw` cannot take `cell-4`, which a cell has; the second `note` takes `cell-5`.
  const cells = [intro, note, draw, { ...note, id: 'cell-4' }, draw, note];
  const file = notebookDownload(viewOf({ ...stored, cells }));
  const ids = ['intro', 'note', 'draw', 'cell-4', 'cell-4-2', 'cell-5'];
  expect(file.cells.map(({ id }) => id)).toEqual(ids);
  const types = ['markdown', 'raw', 'code', 'raw', 'code', 'raw'];
  expect(file.cells.map(({ cell_type }) => cell_type)).toEqual(types);
  expect(parseNotebook(JSON.stringify(file))).toMatchObject({ ok: true });
});

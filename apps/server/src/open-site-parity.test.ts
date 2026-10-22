import {
  openResource,
  type StoredNotebook,
  type StoredNotebookOutput,
  storedNotebook,
  viewNotebook,
} from '@parallax/contracts';
import { expect, test } from 'vitest';
import { labNotebookFile } from '../test/fixtures/notebook';
import { renderNotebook } from './content/notebook';
import { resolveReadingImages } from './content/reading';
import { notebookView } from './http/routes/notebooks.routes';

/**
 * `viewNotebook` of the contracts restates `notebookView` of the notebook route, which a level 0
 * build cannot load (docs/design/open-site.md §3). These tests fail when one changes alone.
 */

const image = 'open/objects/aa';
const figure = `<p><img data-object-key="${image}" alt="Reef"></p>`;
const none = { executionCount: null };
const whole = { ...none, truncated: false };
const cleaned = { ...none, scriptsRemoved: true };
const row = (text: string, header: boolean) => [{ text, header }];
/** One stored output of every type: a type added to the contract fails typecheck here. */
const outputs: Record<StoredNotebookOutput['type'], StoredNotebookOutput> = {
  text: { ...whole, type: 'text', stream: 'stderr', text: '12.0' },
  error: { ...whole, type: 'error', name: 'KeyError', value: 'site', traceback: 'line 1' },
  image: { ...cleaned, type: 'image', key: image, contentType: 'image/svg+xml', alt: 'Counts' },
  table: { ...none, type: 'table', caption: null, head: [row('site', true)], body: [], notes: [] },
  html: { ...cleaned, type: 'html', key: 'open/objects/bb', height: 80 },
  markdown: { ...none, type: 'markdown', html: figure },
  unsupported: { ...none, type: 'unsupported', mimeTypes: ['text/javascript'] },
};
const shown = { sourceHidden: false, outputsHidden: true, outputs: Object.values(outputs) };
const byHand: StoredNotebook = {
  kernel: 'Python 3',
  language: 'python',
  outline: [{ cellId: 'intro', level: 1, text: 'Counts' }],
  cells: [
    { id: 'intro', type: 'markdown', html: `<h1>Counts</h1>${figure}` },
    { id: 'note', type: 'raw', text: 'Counted at low tide.' },
    { id: 'draw', type: 'code', source: 'counts.mean()', executionCount: 2, ...shown },
  ],
};
const address = (key: string) => `https://content.example.org/o/${key.split('/').pop()}`;

test('the stored notebook made by hand has one output of every type storedNotebook names', () => {
  const named = storedNotebook.shape.cells.element.options.flatMap((cell) =>
    'outputs' in cell.shape
      ? cell.shape.outputs.element.options.flatMap((output) => [...output.shape.type.values])
      : [],
  );
  const held = Object.entries(outputs).map(([type, output]) => `${type}: ${output.type}`);
  expect(held.sort()).toEqual(named.map((type) => `${type}: ${type}`).sort());
  expect(storedNotebook.parse(byHand)).toEqual(byHand);
});

test.each<[name: string, stored: () => StoredNotebook]>([
  ['the lab notebook', () => renderNotebook(labNotebookFile, 'open').notebook],
  ['a stored notebook with one output of every type', () => byHand],
])('viewNotebook with resolveReadingImages gives what the route gives for %s', (_name, stored) => {
  const refusing = (key: string) => (key === image ? null : address(key));
  for (const urlFor of [address, refusing, () => null]) {
    const view = viewNotebook(stored(), urlFor, resolveReadingImages);
    expect(view).toEqual(notebookView(stored(), urlFor));
    // It holds nothing that the schema of the data file drops: no storage key, no content type.
    const file = {
      type: 'notebook',
      title: 'Counts',
      file: address('dd.ipynb'),
      data: null,
      notebook: view,
    };
    expect(openResource.parse(file)).toEqual(file);
  }
});

import type { CourseScope } from '../../src/auth/scope';
import { renderNotebook } from '../../src/content/notebook';
import type { Db } from '../../src/db/client';
import { storeCourseObject } from '../../src/storage/objects';
import { courseObjectPrefix, type Storage } from '../../src/storage/storage';

/** A one-pixel PNG. */
export const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** The `.ipynb` text of the lab notebook: Markdown with math, code, text, a table, an image and HTML. */
export const labNotebookFile = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {
    kernelspec: { name: 'python3', display_name: 'Python 3' },
    language_info: { name: 'python' },
  },
  cells: [
    {
      id: 'intro',
      cell_type: 'markdown',
      metadata: {},
      source: '# Repeated samples, in code\n\nThe standard error is $\\sigma / \\sqrt{n}$.',
    },
    {
      id: 'draw',
      cell_type: 'code',
      metadata: {},
      execution_count: 1,
      source: 'means = samples.mean(axis=1)\nmeans.std(ddof=1)',
      outputs: [
        {
          output_type: 'execute_result',
          execution_count: 1,
          metadata: {},
          data: { 'text/plain': '0.60' },
        },
      ],
    },
    {
      id: 'chart',
      cell_type: 'code',
      metadata: {},
      execution_count: 2,
      source: 'display(HTML(chart))',
      outputs: [
        {
          output_type: 'display_data',
          metadata: {},
          data: {
            'text/html':
              '<p id="state">Chart without script</p><script>parent.postMessage("notebook-script-ran","*")</script>',
          },
        },
        {
          output_type: 'display_data',
          metadata: {},
          data: { 'image/png': PNG, 'text/plain': 'Histogram of means' },
        },
      ],
    },
    { id: 'larger', cell_type: 'markdown', metadata: {}, source: '## Try a larger sample' },
  ],
});

/**
 * A stored HTML output whose script survived (as if import sanitising had failed): the browser
 * tests show that the frame and the content origin's policy still keep it from running.
 */
const unsanitised =
  '<!doctype html><html><body><p id="state">Script did not run</p>' +
  '<script>document.getElementById("state").textContent="Script ran";' +
  'parent.postMessage("notebook-script-ran","*")</script></body></html>';

/** The derived outputs the import job would write for the lab notebook, plus the unsanitised frame. */
export async function labNotebookDerived(
  db: Db,
  storage: Storage,
  owner: CourseScope,
): Promise<Record<string, unknown>> {
  const rendered = renderNotebook(labNotebookFile, courseObjectPrefix(owner.courseId));
  for (const object of rendered.objects) {
    await storeCourseObject(db, storage, owner, object.bytes, object.contentType);
  }
  const raw = await storeCourseObject(
    db,
    storage,
    owner,
    Buffer.from(unsanitised),
    'text/html; charset=utf-8',
  );
  const notebook = structuredClone(rendered.notebook);
  const chart = notebook.cells.find((c) => c.id === 'chart');
  if (chart?.type !== 'code') throw new Error('the lab notebook has no chart cell');
  chart.outputs.push({
    type: 'html',
    executionCount: null,
    key: raw.key,
    height: 80,
    scriptsRemoved: false,
  });
  return {
    notebook,
    objects: {
      ...Object.fromEntries(rendered.objects.map((o) => [o.key, o.contentType])),
      [raw.key]: 'text/html; charset=utf-8',
    },
    warnings: rendered.warnings,
  };
}

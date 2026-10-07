import { parseNotebook } from '@parallax/contracts';
import hostileLive from '@parallax/contracts/fixtures/hostile-live-output.json';
import { describe, expect, test } from 'vitest';
import {
  buildNotebook,
  MAX_OUTPUT_CHARS,
  plainText,
  renderLiveOutput,
  renderNotebook,
  sanitizeSvg,
} from './notebook';

const prefix = 'courses/00000000-0000-4000-8000-000000000001';
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const notebook = (cells: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3' },
      language_info: { name: 'python' },
    },
    cells,
    ...extra,
  });

const code = (id: string, source: string, outputs: unknown[], count: number | null = 1) => ({
  id,
  cell_type: 'code',
  metadata: {},
  execution_count: count,
  source,
  outputs,
});

const render = (cells: unknown[]) => renderNotebook(notebook(cells), prefix);

const outputsOf = (rendered: ReturnType<typeof render>, index = 0) => {
  const cell = rendered.notebook.cells[index];
  if (cell?.type !== 'code') throw new Error('not a code cell');
  return cell.outputs;
};

describe('nbformat import contract', () => {
  test('accepts an nbformat 4.5 notebook', () => {
    const parsed = parseNotebook(notebook([code('a', 'x = 1', [])]));
    expect(parsed.ok).toBe(true);
  });

  test('refuses text that is not JSON, nbformat 3, and cells of an unknown type', () => {
    expect(parseNotebook('{nope')).toEqual({
      ok: false,
      error: expect.stringContaining('not valid JSON'),
    });
    expect(parseNotebook(JSON.stringify({ nbformat: 3, worksheets: [] }))).toEqual({
      ok: false,
      error: expect.stringContaining('Only nbformat 4'),
    });
    const bad = parseNotebook(
      notebook([{ id: 'a', cell_type: 'widget', metadata: {}, source: '' }]),
    );
    expect(bad).toEqual({ ok: false, error: expect.stringContaining('cells.0') });
  });

  test('refuses a 4.5 notebook whose cells lack ids or share one', () => {
    const missing = parseNotebook(notebook([{ cell_type: 'markdown', metadata: {}, source: 'x' }]));
    expect(missing).toEqual({ ok: false, error: expect.stringContaining('no id') });
    const twice = parseNotebook(
      notebook([
        { id: 'a', cell_type: 'markdown', metadata: {}, source: 'x' },
        { id: 'a', cell_type: 'markdown', metadata: {}, source: 'y' },
      ]),
    );
    expect(twice).toEqual({ ok: false, error: expect.stringContaining('share an id') });
  });

  test('numbers the cells of an older 4.x notebook, which have no ids', () => {
    const old = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 2,
      metadata: {},
      cells: [
        { cell_type: 'markdown', metadata: {}, source: ['# Title'] },
        { cell_type: 'code', metadata: {}, execution_count: null, source: [], outputs: [] },
      ],
    });
    const { notebook: nb } = renderNotebook(old, prefix);
    expect(nb.cells.map((c) => c.id)).toEqual(['cell-0', 'cell-1']);
    expect(nb.kernel).toBeNull();
  });
});

describe('rendering', () => {
  test('keeps cell order, execution counts, the kernel name and an outline of headings', () => {
    const rendered = render([
      {
        id: 'm1',
        cell_type: 'markdown',
        metadata: {},
        source: ['# Repeated samples\n', '\n', 'The mean $\\bar x$.'],
      },
      code(
        'c1',
        'means.std(ddof=1)',
        [
          {
            output_type: 'execute_result',
            execution_count: 2,
            metadata: {},
            data: { 'text/plain': '0.60' },
          },
        ],
        2,
      ),
      { id: 'm2', cell_type: 'markdown', metadata: {}, source: '## Try a larger sample' },
      { id: 'r1', cell_type: 'raw', metadata: {}, source: 'raw text' },
    ]);
    const { cells, kernel, language, outline } = rendered.notebook;
    expect(kernel).toBe('Python 3');
    expect(language).toBe('python');
    expect(cells.map((c) => c.type)).toEqual(['markdown', 'code', 'markdown', 'raw']);
    expect(cells[0]).toMatchObject({ type: 'markdown', html: expect.stringContaining('<math') });
    expect(cells[1]).toMatchObject({ executionCount: 2, source: 'means.std(ddof=1)' });
    expect(outputsOf(rendered, 1)).toEqual([
      { type: 'text', executionCount: 2, stream: null, text: '0.60', truncated: false },
    ]);
    expect(outline).toEqual([
      { cellId: 'm1', level: 1, text: 'Repeated samples' },
      { cellId: 'm2', level: 2, text: 'Try a larger sample' },
    ]);
  });

  test('merges consecutive writes to one stream and strips terminal escapes from errors', () => {
    const outputs = outputsOf(
      render([
        code('c', 'print()', [
          { output_type: 'stream', name: 'stdout', text: ['a\n'] },
          { output_type: 'stream', name: 'stdout', text: 'b\n' },
          { output_type: 'stream', name: 'stderr', text: 'warn\n' },
          {
            output_type: 'error',
            ename: 'ValueError',
            evalue: 'bad value',
            traceback: ['\u001b[0;31mValueError\u001b[0m: bad value'],
          },
        ]),
      ]),
    );
    expect(outputs).toEqual([
      { type: 'text', executionCount: null, stream: 'stdout', text: 'a\nb\n', truncated: false },
      { type: 'text', executionCount: null, stream: 'stderr', text: 'warn\n', truncated: false },
      {
        type: 'error',
        executionCount: null,
        name: 'ValueError',
        value: 'bad value',
        traceback: 'ValueError: bad value',
        truncated: false,
      },
    ]);
  });

  test('cuts very long text and says so', () => {
    const [out] = outputsOf(
      render([
        code('c', 'x', [
          { output_type: 'stream', name: 'stdout', text: 'x'.repeat(MAX_OUTPUT_CHARS + 10) },
        ]),
      ]),
    );
    expect(out).toMatchObject({ type: 'text', truncated: true });
    expect(out?.type === 'text' && out.text.length).toBe(MAX_OUTPUT_CHARS);
  });

  test('a carriage return overwrites its line, as in a terminal', () => {
    expect(plainText('10%\r50%\r100%\ndone')).toBe('100%\ndone');
  });

  test('stores an image output as an object under the course prefix, keyed by its bytes', () => {
    const rendered = render([
      code('c', 'plot()', [
        {
          output_type: 'display_data',
          metadata: {},
          data: { 'image/png': PNG, 'text/plain': '<Figure size 640x480 with 1 Axes>' },
        },
      ]),
    ]);
    const [out] = outputsOf(rendered);
    expect(out).toMatchObject({
      type: 'image',
      contentType: 'image/png',
      key: expect.stringMatching(new RegExp(`^${prefix}/objects/[0-9a-f]{64}$`)),
      alt: '<Figure size 640x480 with 1 Axes>',
    });
    expect(rendered.objects).toHaveLength(1);
    expect(rendered.objects[0]?.contentType).toBe('image/png');
    expect(Buffer.from(rendered.objects[0]?.bytes ?? []).toString('base64')).toBe(PNG);
  });

  test('a DataFrame table becomes text rows, with its header and trailing note', () => {
    const html =
      '<div><style scoped>.dataframe tbody tr th { vertical-align: top; }</style>' +
      '<table border="1" class="dataframe"><thead><tr><th></th><th>mean</th></tr></thead>' +
      '<tbody><tr><th>0</th><td>10.1</td></tr><tr><th>1</th><td>9.<b>8</b></td></tr></tbody></table>' +
      '<p>2 rows × 1 columns</p></div>';
    const [out] = outputsOf(
      render([
        code(
          'c',
          'df',
          [
            {
              output_type: 'execute_result',
              execution_count: 3,
              metadata: {},
              data: { 'text/html': html, 'text/plain': 'df' },
            },
          ],
          3,
        ),
      ]),
    );
    expect(out).toEqual({
      type: 'table',
      executionCount: 3,
      caption: null,
      head: [
        [
          { text: '', header: true },
          { text: 'mean', header: true },
        ],
      ],
      body: [
        [
          { text: '0', header: true },
          { text: '10.1', header: false },
        ],
        [
          { text: '1', header: true },
          { text: '9.8', header: false },
        ],
      ],
      notes: ['2 rows × 1 columns'],
    });
  });

  test('outputs that need a live kernel or scripts are named, not rendered', () => {
    const [out] = outputsOf(
      render([
        code('c', 'widget', [
          {
            output_type: 'display_data',
            metadata: {},
            data: {
              'application/javascript': 'alert(1)',
              'application/vnd.jupyter.widget-view+json': { model_id: 'x' },
            },
          },
        ]),
      ]),
    );
    expect(out).toEqual({
      type: 'unsupported',
      executionCount: null,
      mimeTypes: ['application/javascript', 'application/vnd.jupyter.widget-view+json'],
    });
  });

  test('honours the notebook’s own collapsed source and output', () => {
    const { notebook: nb } = render([
      {
        ...code('c', 'x', []),
        metadata: { jupyter: { source_hidden: true, outputs_hidden: true } },
      },
    ]);
    expect(nb.cells[0]).toMatchObject({ sourceHidden: true, outputsHidden: true });
  });

  test('resolves a Markdown cell’s attached image to an object of the notebook', () => {
    const rendered = render([
      {
        id: 'm',
        cell_type: 'markdown',
        metadata: {},
        source: '![diagram](attachment:diagram.png)',
        attachments: { 'diagram.png': { 'image/png': PNG } },
      },
    ]);
    const [cell] = rendered.notebook.cells;
    const key = rendered.objects[0]?.key;
    expect(key).toBeDefined();
    expect(cell).toMatchObject({
      type: 'markdown',
      html: expect.stringContaining(`data-object-key="${key}"`),
    });
  });
});

describe('A09 stored HTML and JavaScript outputs cannot run script', () => {
  const hostile =
    '<div onclick="steal()">Chart<script>fetch("/api/me").then(r=>r.text()).then(t=>parent.postMessage(t,"*"))</script>' +
    '<img src="x" onerror="alert(1)"><a href="javascript:alert(2)">link</a>' +
    '<iframe src="https://evil.example"></iframe></div>';

  const rendered = render([
    code('c', 'display(HTML(...))', [
      {
        output_type: 'display_data',
        metadata: {},
        data: { 'text/html': hostile, 'text/plain': '<IPython.core.display.HTML object>' },
      },
    ]),
  ]);
  const [out] = outputsOf(rendered);
  const doc = new TextDecoder().decode(rendered.objects[0]?.bytes);

  test('A09 an HTML output is a separate document for the content origin, never inline markup', () => {
    expect(out).toMatchObject({
      type: 'html',
      key: expect.stringMatching(new RegExp(`^${prefix}/objects/[0-9a-f]{64}$`)),
      scriptsRemoved: true,
    });
    expect(rendered.objects[0]?.contentType).toBe('text/html; charset=utf-8');
    // The stored notebook (what the app origin receives) carries no part of the output's markup.
    expect(JSON.stringify(rendered.notebook)).not.toContain('steal');
  });

  test('A09 the HTML output document holds no script, event handler, script URL or frame', () => {
    expect(doc).toContain('Chart');
    expect(doc).not.toMatch(/<script/i);
    expect(doc).not.toMatch(/\son[a-z]+=/i);
    expect(doc).not.toMatch(/javascript:/i);
    expect(doc).not.toMatch(/<iframe/i);
  });

  const hostileSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)">' +
    '<script>alert(1)</script><foreignObject><div>x</div></foreignObject>' +
    '<a href="javascript:alert(2)"><rect width="5" height="5" fill="red" onclick="alert(3)"/></a>' +
    '<image href="https://evil.example/x.png"/><use href="https://evil.example/s.svg#a"/>' +
    '<style>@import url(https://evil.example/a.css);rect{fill:blue}</style>' +
    '<circle r="2" style="fill:url(https://evil.example/p)"/><animate attributeName="href" to="javascript:alert(4)"/>' +
    '<circle id="keep" cx="5" cy="5" r="2" fill="#00f"/></svg>';

  test('A09 an SVG output is stored without script, handlers, foreign content or external references', () => {
    const svgRendered = render([
      code('s', 'plot()', [
        { output_type: 'display_data', metadata: {}, data: { 'image/svg+xml': hostileSvg } },
      ]),
    ]);
    const [svgOut] = outputsOf(svgRendered);
    expect(svgOut).toMatchObject({
      type: 'image',
      contentType: 'image/svg+xml',
      scriptsRemoved: true,
    });
    const stored = new TextDecoder().decode(svgRendered.objects[0]?.bytes);
    expect(stored).toContain('<circle id="keep"');
    expect(stored).not.toMatch(/<script|<foreignObject|<animate|<a[ >]/i);
    expect(stored).not.toMatch(/\son[a-z]+=|javascript:|evil\.example|@import|url\(/i);
  });

  const NS = 'xmlns="http://www.w3.org/2000/svg"';
  const storedSvg = (svg: string) => {
    const out = sanitizeSvg(svg);
    if (!out) throw new Error('no svg root');
    // The stored text read back as SVG holds no script, foreign content or handler.
    expect(out.text).not.toMatch(
      /<script|<foreignObject|\son[a-z]+=|<img|<style[^>]*>[^<]*<(?!\/style>)/i,
    );
    expect(out.text.startsWith('<svg')).toBe(true);
    expect(out.text.endsWith('</svg>')).toBe(true);
    return out;
  };

  test('A09 entity-escaped or CDATA markup in an SVG style never comes back as an element', () => {
    for (const payload of [
      '&lt;script&gt;alert(1)&lt;/script&gt;',
      '<![CDATA[</style><script>alert(1)</script><style>]]>',
      '&lt;foreignObject&gt;&lt;img src="x" onerror="alert(1)"/&gt;&lt;/foreignObject&gt;',
    ]) {
      const out = storedSvg(`<svg ${NS}><style>${payload}</style><circle r="1"/></svg>`);
      expect(out.scriptsRemoved).toBe(true);
      expect(out.text).toContain('<circle');
    }
  });

  test('A09 SVG CSS that escapes, imports or fetches is dropped; local url() references stay', () => {
    const out = storedSvg(
      `<svg ${NS}><style>@\\69 mport "https://evil.example/a.css";</style>` +
        '<rect fill="\\75 rl(https://evil.example/p)" width="1"/>' +
        '<rect style="fill:image-set(\'https://evil.example/q\')" width="2"/>' +
        `<g clip-path="url('#c')" filter="url(  #f)" fill="url(&quot;#p&quot;)"><path d="M0 0"/></g>` +
        '<style>rect{stroke:#000}</style></svg>',
    );
    expect(out.text).not.toMatch(/evil\.example|@|\\/);
    expect(out.text).toContain('clip-path="url(&#x27;#c&#x27;)"');
    expect(out.text).toContain('rect{stroke:#000}');
  });

  test('A09 a matplotlib-shaped SVG keeps its in-document xlink references and loses its metadata', () => {
    const out = storedSvg(
      `<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 9 9">` +
        '<metadata><rdf:RDF>Matplotlib v3, 2026-01-01</rdf:RDF></metadata>' +
        '<defs><path id="g" d="M0 0"/></defs><use xlink:href="#g" x="1"/>' +
        '<use xlink:href="https://evil.example/s.svg#g"/></svg>',
    );
    expect(out.text).toMatch(/<use [^>]*xlink:href="#g"/);
    expect(out.text).not.toMatch(/Matplotlib|evil\.example/);
  });

  test('A09 HTML-only tags inside an SVG do not leave content after the root element', () => {
    const out = storedSvg(`<svg ${NS}><p>x</p><circle r="1"/></svg>`);
    expect(out.text.match(/<svg/g)).toHaveLength(1);
    expect(sanitizeSvg('<div>no svg</div>')).toBeNull();
  });

  test('A09 a stripped element cannot split a token so that an external url( is rebuilt', () => {
    for (const split of ['u<set>x</set>rl', 'u<script>x</script>rl', 'u<metadata>x</metadata>rl']) {
      const out = storedSvg(
        `<svg ${NS}><style>rect{fill:${split}(https://evil.example/p)}</style><rect width="1"/></svg>`,
      );
      expect(out.text).not.toMatch(/evil\.example|url\(/);
      expect(out.text).toContain('<rect');
    }
    const nested = storedSvg(`<svg ${NS}><style>rect{fill:red}<circle r="1"/></style></svg>`);
    expect(nested.text).not.toContain('<style');
  });

  test('A09 stroke, text and paint attributes survive; the root carries its namespaces', () => {
    const out = storedSvg(
      '<svg width="4"><path stroke-dasharray="2 2" stroke-linecap="round" stroke-linejoin="round" d="M0 0"/>' +
        '<text xml:space="preserve" paint-order="stroke" color="red">a  b</text>' +
        '<use xlink:href="#a"/></svg>',
    );
    for (const kept of [
      'stroke-dasharray="2 2"',
      'stroke-linecap="round"',
      'stroke-linejoin="round"',
      'xml:space="preserve"',
      'paint-order="stroke"',
      'xmlns="http://www.w3.org/2000/svg"',
      'xmlns:xlink="http://www.w3.org/1999/xlink"',
    ]) {
      expect(out.text).toContain(kept);
    }
    expect(out.scriptsRemoved).toBe(false);
  });

  test('A09 an embedded raster stays only as a PNG, JPEG, GIF or WebP data URI', () => {
    const out = storedSvg(
      `<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink">` +
        `<image width="1" height="1" xlink:href="data:image/png;base64,${PNG}"/>` +
        '<image href="https://evil.example/x.png"/>' +
        '<image href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="/></svg>',
    );
    expect(out.text.match(/<image/g)).toHaveLength(3);
    expect(out.text).toContain(`xlink:href="data:image/png;base64,${PNG}"`);
    expect(out.text).not.toMatch(/evil\.example|svg\+xml/);
  });

  test('A09 animation that could set a script URL is removed and reported', () => {
    const out = storedSvg(
      `<svg ${NS}><animate attributeName="href" to="javascript:alert(1)"/><rect/></svg>`,
    );
    expect(out.scriptsRemoved).toBe(true);
    expect(out.text).not.toMatch(/animate|javascript/i);
  });

  test('A09 foreignObject, animation and style content without script do not claim scripts were removed', () => {
    for (const body of [
      '<switch><foreignObject><div>Label</div></foreignObject><text>Label</text></switch>',
      '<circle r="1"><animate attributeName="r" to="3"/></circle>',
      '<style>b{}<desc/></style><rect/>',
    ]) {
      const out = storedSvg(`<svg ${NS}>${body}</svg>`);
      expect(out.scriptsRemoved).toBe(false);
      expect(out.text).not.toMatch(/foreignObject|<animate/);
    }
    // A script inside foreign content still counts.
    expect(
      storedSvg(`<svg ${NS}><foreignObject><img src="x" onerror="alert(1)"/></foreignObject></svg>`)
        .scriptsRemoved,
    ).toBe(true);
  });

  test('A09 a style element keeps its media attribute so a print stylesheet stays print-only', () => {
    const out = storedSvg(`<svg ${NS}><style media="print">rect{fill:red}</style><rect/></svg>`);
    expect(out.text).toContain('<style media="print">');
  });

  test('A09 a reference with leading Unicode whitespace is not treated as in-document', () => {
    for (const lead of ['\u00a0', '\u2003', '\ufeff']) {
      const out = storedSvg(`<svg ${NS}><use href="${lead}#a"/><use href="  #b"/></svg>`);
      expect(out.text).not.toContain(`href="${lead}#a"`);
      expect(out.text).toContain('href="  #b"');
    }
  });

  test('A09 namespaces other than the root are dropped, as are values that would break the XML', () => {
    const out = storedSvg(
      `<svg ${NS}><g xmlns="http://www.w3.org/1999/xhtml" id="a<b"><rect id="ok"/></g><text>x]]>y</text></svg>`,
    );
    expect(out.text).not.toMatch(/xhtml|a<b|\]\]>/);
    expect(out.text).toContain('id="ok"');
  });

  test('A09 a stylesheet with an ampersand or a word like expression is kept', () => {
    const out = storedSvg(
      `<svg ${NS}><style>.expression-label{fill:red}</style><text font-family="A&amp;B">x</text></svg>`,
    );
    expect(out.text).toContain('.expression-label{fill:red}');
    expect(out.text).toContain('font-family="A&#x26;B"');
  });

  test('A09 an SVG output without an svg element falls back to its text/plain', () => {
    const rendered = render([
      code('s', 'plot()', [
        {
          output_type: 'display_data',
          metadata: {},
          data: { 'image/svg+xml': '<div>not svg</div>', 'text/plain': 'Figure 1' },
        },
      ]),
    ]);
    expect(outputsOf(rendered)[0]).toMatchObject({ type: 'text', text: 'Figure 1' });
    expect(rendered.objects).toHaveLength(0);
  });

  test('A09 a clean SVG output is kept and not flagged', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><path d="M0 0L4 4" stroke="#000"/></svg>';
    const clean = render([
      code('s', 'plot()', [
        { output_type: 'display_data', metadata: {}, data: { 'image/svg+xml': svg } },
      ]),
    ]);
    const [out] = outputsOf(clean);
    expect(out).not.toHaveProperty('scriptsRemoved');
    const stored = new TextDecoder().decode(clean.objects[0]?.bytes);
    expect(stored).toContain('<path d="M0 0L4 4" stroke="#000">');
    expect(stored).toContain('viewBox="0 0 4 4"');
  });

  test('A09 an SVG attachment of a Markdown cell is sanitised like an SVG output', () => {
    const attached = render([
      {
        id: 'm',
        cell_type: 'markdown',
        metadata: {},
        source: '![d](attachment:d.svg)',
        attachments: { 'd.svg': { 'image/svg+xml': hostileSvg } },
      },
    ]);
    const stored = new TextDecoder().decode(attached.objects[0]?.bytes);
    expect(attached.objects[0]?.contentType).toBe('image/svg+xml');
    expect(stored).not.toMatch(/<script|\son[a-z]+=|javascript:|evil\.example/i);
  });

  test('A09 Markdown cells cannot carry raw HTML or script into the app origin', () => {
    const { notebook: nb } = render([
      {
        id: 'm',
        cell_type: 'markdown',
        metadata: {},
        source:
          'Text <script>alert(1)</script><img src=x onerror=alert(2)> [x](javascript:alert(3))',
      },
    ]);
    const [cell] = nb.cells;
    const html = cell?.type === 'markdown' ? cell.html : '';
    expect(html).toContain('Text');
    expect(html).not.toMatch(/<script|onerror|javascript:/i);
  });

  test('A09 an HTML output with a static image alternative shows the image instead', () => {
    const [img] = outputsOf(
      render([
        code('c', 'fig', [
          {
            output_type: 'display_data',
            metadata: {},
            data: { 'text/html': '<script>draw()</script>', 'image/png': PNG },
          },
        ]),
      ]),
    );
    expect(img).toMatchObject({ type: 'image' });
  });
});

test('buildNotebook names only objects it was given bytes for', () => {
  const parsed = parseNotebook(notebook([code('c', 'x', [])]));
  if (!parsed.ok) throw new Error(parsed.error);
  expect(buildNotebook(parsed.notebook, prefix).objects).toEqual([]);
});

describe('A09 live output is rendered by the stored-output rules', () => {
  const livePrefix = 'classes/00000000-0000-4000-8000-000000000002/live-outputs/s';
  const stored = (data: Record<string, unknown>) =>
    buildNotebook(
      {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
          {
            id: 'c',
            cell_type: 'code',
            metadata: {},
            execution_count: 7,
            source: '',
            outputs: [{ output_type: 'execute_result', execution_count: 7, metadata: {}, data }],
          },
        ],
      },
      livePrefix,
    );

  for (const name of ['html', 'svg', 'markdown'] as const) {
    test(`A09 the hostile ${name} fixture gives the same output live as stored`, () => {
      const data = hostileLive[name] as Record<string, unknown>;
      const fromFile = stored(data);
      const live = renderLiveOutput(data, 7, livePrefix);
      const cell = fromFile.notebook.cells[0];
      expect(cell?.type === 'code' && cell.outputs).toEqual([live.output]);
      expect(live.objects).toEqual(fromFile.objects);
      const text = live.objects.map((o) => new TextDecoder().decode(o.bytes)).join('');
      const markup = live.output.type === 'markdown' ? live.output.html : text;
      expect(markup).not.toMatch(
        /<script|<iframe|<object|<embed|foreignObject|<animate|\son[a-z]+=|javascript:/i,
      );
    });
  }

  test('A09 scriptsRemoved says what the sanitiser removed, live as stored', () => {
    expect(renderLiveOutput(hostileLive.html, 1, livePrefix).output).toMatchObject({
      type: 'html',
      scriptsRemoved: true,
    });
    expect(renderLiveOutput(hostileLive.svg, 1, livePrefix).output).toMatchObject({
      type: 'image',
      scriptsRemoved: true,
    });
    // Benign markup of the same kinds: nothing was removed, and nothing says it was.
    expect(
      renderLiveOutput({ 'text/html': '<p style="color:red">plain <b>text</b></p>' }, 1, livePrefix)
        .output,
    ).toMatchObject({ type: 'html', scriptsRemoved: false });
    expect(
      renderLiveOutput(
        { 'image/svg+xml': '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>' },
        1,
        livePrefix,
      ).output,
    ).not.toHaveProperty('scriptsRemoved');
  });

  test('A09 live objects are keyed under the session prefix as storage names them', () => {
    const { output, objects } = renderLiveOutput({ 'image/png': PNG }, null, livePrefix);
    expect(output).toMatchObject({ type: 'image', executionCount: null, contentType: 'image/png' });
    expect(objects).toHaveLength(1);
    expect(objects[0]?.key).toMatch(new RegExp(`^${livePrefix}/objects/[0-9a-f]{64}$`));
  });
});

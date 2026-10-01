import { describe, expect, test } from 'vitest';
import { makePdf } from '../../test/fixtures/pdf';
import { cleanPageText, extractPdfText } from './pdf-text';
import { blockId, normaliseText, renderReading, resolveReadingImages } from './reading';
import { renderReadingInThread } from './reading-render';
import { ThreadInputError } from './thread';

const KEY = 'courses/00000000-0000-4000-8000-000000000101/objects/abc123';

const v1 = `# Why samples vary

Every sample tells a slightly different story.

The sampling distribution describes that variation.

Every sample tells a slightly different story.

![Histogram of means](means.png "Means of 1000 samples")
`;

/** v1 edited: second paragraph reworded, a paragraph inserted at the top, text re-wrapped. */
const v2 = `# Why samples vary

A new opening paragraph.

Every sample tells a
slightly different story.

The sampling distribution describes how statistics vary.

Every sample tells a slightly different story.

![Histogram of means](means.png "Means of 1000 samples")
`;

const ids = (md: string) =>
  renderReading(md, 'markdown', { 'means.png': KEY }).blockMap.map((b) => ({
    id: b.id,
    text: normaliseText(b.text),
  }));

describe('block ids', () => {
  test('A06 block ids stay stable across an edit: unchanged paragraphs keep their id', () => {
    const before = ids(v1);
    const after = ids(v2);
    const idOf = (list: typeof before, text: string, nth = 0) =>
      list.filter((b) => b.text === text)[nth]?.id;

    // Unchanged blocks keep their ids, even when moved down or re-wrapped.
    for (const text of ['Why samples vary', 'Means of 1000 samples']) {
      expect(idOf(after, text)).toBe(idOf(before, text));
    }
    const repeated = 'Every sample tells a slightly different story.';
    expect(idOf(after, repeated, 0)).toBe(idOf(before, repeated, 0));
    expect(idOf(after, repeated, 1)).toBe(idOf(before, repeated, 1));
    // Repeated text gets distinct ids by occurrence.
    expect(idOf(before, repeated, 0)).not.toBe(idOf(before, repeated, 1));
    // An edited paragraph gets a new id, so its anchors go through quote matching.
    expect(idOf(after, 'The sampling distribution describes how statistics vary.')).not.toBe(
      idOf(before, 'The sampling distribution describes that variation.'),
    );
    expect(new Set(after.map((b) => b.id)).size).toBe(after.length);
  });

  test('A06 the block id is the ADR-0003 hash of normalised text and occurrence', () => {
    const { html, blockMap } = renderReading('Some  text\nhere.', 'markdown');
    expect(blockMap).toEqual([
      { id: blockId('Some text here.', 0), tag: 'p', text: 'Some  text\nhere.' },
    ]);
    expect(blockId('Some text here.', 0)).toMatch(/^[0-9a-f]{12}$/);
    expect(html).toBe(`<p data-block-id="${blockId('Some text here.', 0)}">Some  text\nhere.</p>`);
  });

  test('A06 a loose list item that gains a paragraph leaves its unchanged paragraph’s id', () => {
    const before = renderReading('- item\n\n- other', 'markdown').blockMap;
    const after = renderReading('- item\n\n  para\n\n- other', 'markdown').blockMap;
    const idOf = (map: typeof before, text: string) => map.find((b) => b.text === text)?.id;
    expect(idOf(after, 'item')).toBe(idOf(before, 'item'));
    expect(idOf(after, 'other')).toBe(idOf(before, 'other'));
    // The list items only wrap paragraphs: the paragraphs carry the ids.
    expect(after.map((b) => b.tag)).toEqual(['p', 'p', 'p']);
  });

  test('A06 a blockquote wrapping paragraphs gets no id; a tight list item with text keeps one', () => {
    const quoted = renderReading('> item\n>\n> more', 'markdown');
    expect(quoted.blockMap.map((b) => b.tag)).toEqual(['p', 'p']);
    expect(quoted.html).toMatch(/^<blockquote>/);
    const nested = renderReading('- item\n  - sub', 'markdown').blockMap;
    expect(nested.map((b) => [b.tag, normaliseText(b.text)])).toEqual([
      ['li', 'item sub'],
      ['li', 'sub'],
    ]);
  });

  test('A06 a loose list item holding only an image wraps its figure, with or without a caption', () => {
    for (const md of ['- ![a](means.png)\n\n- other', '- ![a](means.png "Means")\n\n- other']) {
      const { blockMap, figures } = renderReading(md, 'markdown', { 'means.png': KEY });
      expect(blockMap.map((b) => b.tag)).not.toContain('li');
      expect(figures).toHaveLength(1);
    }
  });

  test('A06 figure ids follow the image, not the text around it', () => {
    const fig = (md: string) => renderReading(md, 'markdown', { 'means.png': KEY }).figures;
    const [before] = fig(v1);
    const [after] = fig(v2);
    expect(before).toMatchObject({
      objectKey: KEY,
      alt: 'Histogram of means',
      caption: 'Means of 1000 samples',
    });
    expect(after?.id).toBe(before?.id);
  });
});

describe('rendering', () => {
  test('headings, equations as MathML, code, tables and citation footnotes', () => {
    const { html } = renderReading(
      [
        'Mean $\\bar{x}$ is unbiased.[^cochran]',
        '',
        '$$',
        '\\sigma^2 / n',
        '$$',
        '',
        '```python',
        'print(1)',
        '```',
        '',
        '| n | se |',
        '|:-|-:|',
        '| 10 | 0.3 |',
        '',
        '[^cochran]: Cochran, *Sampling Techniques*, 1977.',
      ].join('\n'),
      'markdown',
    );
    expect(html).toContain('<span class="katex"><math><semantics>');
    expect(html).toMatch(
      /<div class="math-display" data-block-id="[0-9a-f]{12}"><math display="block">/,
    );
    expect(html).toContain(
      '<code class="hljs language-python"><span class="hljs-built_in">print</span>',
    );
    expect(html).toMatch(/<td align="right" data-block-id="[0-9a-f]{12}">0.3<\/td>/);
    // Footnote links point at the prefixed ids the sanitiser gives.
    expect(html).toContain('href="#user-content-fn-cochran" id="user-content-fnref-cochran"');
    expect(html).toContain('<li id="user-content-fn-cochran"');
    expect(html).toContain('href="#user-content-fnref-cochran"');
    expect(html).not.toContain('style=');
  });

  test('uploaded HTML loses scripts, handlers, styles, frames and unsafe URLs', () => {
    const { html } = renderReading(
      [
        '<h2 onclick="steal()" style="position:fixed;inset:0">Title</h2>',
        '<script>alert(1)</script><iframe src="https://evil.example"></iframe>',
        '<p><a href="javascript:alert(1)">bad</a> <a href="https://ok.example/x">ok</a></p>',
        '<picture><source srcset="https://evil.example/t.png"></picture>',
        '<form action="https://evil.example"><input name="pw"></form>',
        '<svg><script>alert(1)</script></svg><p id="app" class="pc-shell" data-block-id="forged">x</p>',
      ].join(''),
      'html',
    );
    for (const bad of [
      'onclick',
      'style',
      'script',
      'iframe',
      'javascript:',
      'srcset',
      'form',
      'svg',
      'forged',
      'pc-shell',
    ]) {
      expect(html).not.toContain(bad);
    }
    expect(html).toContain(
      '<a href="https://ok.example/x" rel="noopener noreferrer nofollow">ok</a>',
    );
    expect(html).toContain('id="user-content-app"');
  });

  test('a whole HTML document keeps only its body; head, styles and fallbacks vanish', () => {
    const { html, blockMap } = renderReading(
      '<html><head><title>Secret title</title><style>body{color:red}</style></head><body>' +
        '<p>Hi</p><iframe src="https://evil.example">fallback</iframe><textarea>text</textarea>' +
        '<noscript>ns</noscript><object>obj</object><template>tpl</template></body></html>',
      'html',
    );
    expect(html).toBe(`<p data-block-id="${blockMap[0]?.id}">Hi</p>`);
  });

  test('in-document links still reach ids that already carry the sanitiser prefix', () => {
    const { html } = renderReading(
      '<h2 id="user-content-x">X</h2><p><a href="#user-content-x">to X</a> <a href="#y">to Y</a></p><p id="y">Y</p>',
      'html',
    );
    expect(html).toContain('id="user-content-user-content-x"');
    expect(html).toContain('href="#user-content-user-content-x"');
    expect(html).toContain('href="#user-content-y"');
    expect(html).toContain('id="user-content-y"');
  });

  test('image names cannot reach object prototype properties', () => {
    const { html, figures, warnings } = renderReading(
      '![a](constructor)\n\n![b](__proto__)\n\n![c](toString)',
      'markdown',
      { 'means.png': KEY },
    );
    expect(html).not.toContain('data-object-key');
    expect(figures.map((f) => f.objectKey)).toEqual([null, null, null]);
    expect(warnings).toHaveLength(3);
  });

  test('images keep only uploaded files of the reading; others lose their source', () => {
    const { html, warnings } = renderReading(
      '![a](./means.png)\n\n![b](https://tracker.example/pixel.png)\n\n![c](missing.png)',
      'markdown',
      { 'means.png': KEY },
    );
    expect(html).toContain(`<img alt="a" data-object-key="${KEY}">`);
    expect(html).toContain('<img alt="b">');
    expect(html).not.toContain('tracker.example');
    expect(warnings).toEqual([
      'Image "https://tracker.example/pixel.png" is not an uploaded file of this reading',
      'Image "missing.png" is not an uploaded file of this reading',
    ]);
  });

  test('images whose source the sanitiser removed are reported to the author', () => {
    const { html, warnings } = renderReading(
      '<p><img src="data:image/png;base64,AAAA" alt="Inline chart"> ' +
        '<img src="javascript:alert(1)" alt="Script"></p>',
      'html',
    );
    expect(html).not.toContain('data:');
    expect(html).not.toContain('javascript:');
    expect(warnings).toEqual([
      'Image "Inline chart" has no usable source; upload it as a file of this reading',
      'Image "Script" has no usable source; upload it as a file of this reading',
    ]);
  });

  test('KaTeX MathML presentation attributes survive; links, sources and styles do not', () => {
    const { html } = renderReading(
      '<math><mstyle mathcolor="red" mathbackground="#eee" mathsize="1.2em">' +
        '<mo largeop="true" linebreak="newline">∑</mo><mpadded voffset="1pt"><mi href="https://evil.example" ' +
        'src="https://evil.example/x" style="position:fixed" xmlns="http://evil.example">x</mi></mpadded>' +
        '</mstyle></math>',
      'html',
    );
    for (const kept of [
      'mathcolor="red"',
      'mathbackground="#eee"',
      'mathsize="1.2em"',
      'largeop="true"',
      'linebreak="newline"',
      'voffset="1pt"',
    ]) {
      expect(html).toContain(kept);
    }
    for (const dropped of ['href', 'src=', ' style=', 'position:fixed', 'xmlns', 'evil.example']) {
      expect(html).not.toContain(dropped);
    }
  });

  test('an equation KaTeX cannot parse is reported, and no empty class is left behind', () => {
    const { html, warnings } = renderReading('Bad $\\frac{$ math', 'markdown');
    expect(warnings).toEqual([
      expect.stringMatching(/^An equation could not be rendered: KaTeX parse error: .*\\frac\{$/),
    ]);
    expect(html).not.toContain('class=""');
    expect(html).toContain('\\frac{');
  });

  test('a fence in a language highlight.js does not know is reported as code, not as math', () => {
    const { html, warnings } = renderReading(
      '```nolang\nx = 1\n```\n\nBad $\\frac{$ math',
      'markdown',
    );
    expect(warnings).toEqual([
      expect.stringMatching(/^An equation could not be rendered: KaTeX parse error: /),
      'Code could not be highlighted: Cannot highlight as `nolang`, it’s not registered',
    ]);
    expect(html).toContain('x = 1');
  });

  test('display math in uploaded HTML becomes a block only where a block may stand', () => {
    const mixed = renderReading('<p><span class="math-display">x^2</span> in para</p>', 'html');
    // Inside a paragraph with other text it stays inline: a div would close the paragraph.
    expect(mixed.html).not.toContain('<div');
    expect(mixed.blockMap.map((b) => b.tag)).toEqual(['p']);

    const alone = renderReading(
      '<p> <span class="math-display">x^2</span>\n</p><div><span class="math-display">y</span></div>',
      'html',
    );
    expect(alone.html).not.toContain('<p');
    expect(alone.blockMap.map((b) => b.tag)).toEqual(['div', 'div']);
    expect(alone.html).toMatch(
      /^<div class="math-display" data-block-id="[0-9a-f]{12}"><math display="block">/,
    );

    // The paragraph's own attributes stay with the block that replaces it, so links still land.
    const linked = renderReading(
      '<p id="eq1" dir="ltr"><span class="math-display">z</span></p><p><a href="#eq1">see</a></p>',
      'html',
    );
    expect(linked.html).toMatch(/^<div id="user-content-eq1" dir="ltr" class="math-display"/);
    expect(linked.html).toContain('href="#user-content-eq1"');
  });

  test('a pre whose text starts with a newline keeps it, so the browser’s text matches the block map', () => {
    const { html, blockMap } = renderReading('<pre>\n\nhello</pre>', 'html');
    const [block] = blockMap;
    expect(block?.text).toBe('\nhello');
    // Parsed again (as a browser and resolveReadingImages do), the text is unchanged.
    const reparsed = renderReading(html, 'html').blockMap[0];
    expect(reparsed?.text).toBe(block?.text);
    const withImage = `${html}<p><img alt="a" data-object-key="${KEY}"></p>`;
    const resolved = resolveReadingImages(withImage, () => 'https://content.example/t');
    expect(resolved).toContain(`<pre data-block-id="${block?.id}">\n\nhello</pre>`);
    expect(resolveReadingImages(resolved, () => 'https://content.example/t')).toBe(resolved);
  });

  test('rendering again gives the same result (processors are shared, not rebuilt)', () => {
    const source = '```python\nprint(1)\n```\n\nText $x$.';
    expect(renderReading(source, 'markdown')).toEqual(renderReading(source, 'markdown'));
  });

  test('raw HTML inside Markdown is dropped', () => {
    const { html } = renderReading('Hi <img src=x onerror=alert(1)> there', 'markdown');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<img');
  });

  test('image references become content URLs at read time', () => {
    const { html } = renderReading('![a](means.png)\n\n![b](other.png)', 'markdown', {
      'means.png': KEY,
      'other.png': `${KEY}def`,
    });
    const resolved = resolveReadingImages(html, (key) =>
      key === KEY ? 'https://content.example/content/tok' : null,
    );
    expect(resolved).toContain(
      `<img alt="a" data-object-key="${KEY}" src="https://content.example/content/tok">`,
    );
    expect(resolved).toContain(`<img alt="b" data-object-key="${KEY}def">`);
  });

  test('HTML without uploaded images is returned as stored, without a parse', () => {
    const html = '<p data-block-id="abc">Text<br/>more</p >';
    let called = false;
    expect(
      resolveReadingImages(html, () => {
        called = true;
        return 'x';
      }),
    ).toBe(html);
    expect(called).toBe(false);
  });
});

describe('rendering in a thread', () => {
  test('renders what renderReading renders, off the calling thread', async () => {
    const source = '# Title\n\n![a](means.png)\n\nMean $\\bar{x}$.';
    const assets = { 'means.png': KEY };
    expect(await renderReadingInThread(source, 'markdown', assets)).toEqual(
      renderReading(source, 'markdown', assets),
    );
  });

  test('a reading the pipeline rejects, or one past the time bound, fails as final', async () => {
    // Assets that are not a record make the image lookup throw inside the pipeline.
    const broken = renderReadingInThread('![a](x.png)', 'markdown', null as never);
    await expect(broken).rejects.toThrow(new ThreadInputError('The reading could not be rendered'));
    await expect(renderReadingInThread('# Slow', 'markdown', {}, { timeoutMs: 1 })).rejects.toThrow(
      new ThreadInputError('Rendering the reading took too long'),
    );
  });

  test('an abort is not a problem with the reading', async () => {
    const controller = new AbortController();
    const pending = renderReadingInThread(
      '# Stopped',
      'markdown',
      {},
      { signal: controller.signal },
    );
    controller.abort();
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ThreadInputError);
  });
});

describe('PDF readings', () => {
  test('A06 page count and per-page text, with a text hash for anchor mapping', async () => {
    const pdf = await extractPdfText(makePdf(['Sampling varies', 'Second page']));
    expect(pdf.pageCount).toBe(2);
    expect(pdf.pages.map((p) => p.text)).toEqual(['Sampling varies', 'Second page']);
    const again = await extractPdfText(makePdf(['Sampling varies', 'Second page changed']));
    expect(again.pages[0]?.textHash).toBe(pdf.pages[0]?.textHash);
    expect(again.pages[1]?.textHash).not.toBe(pdf.pages[1]?.textHash);
  });

  test('the file’s bytes are moved into the parsing thread only when the caller asks', async () => {
    const kept = makePdf(['Kept']);
    expect((await extractPdfText(kept)).pages.map((p) => p.text)).toEqual(['Kept']);
    expect(kept.byteLength).toBeGreaterThan(0);

    const moved = makePdf(['Moved']);
    const pdf = await extractPdfText(moved, { transfer: true });
    expect(pdf.pages.map((p) => p.text)).toEqual(['Moved']);
    expect(moved.byteLength).toBe(0);

    // A view into a larger buffer cannot be moved without taking the rest with it.
    const part = new Uint8Array(new ArrayBuffer(16), 4, 8);
    await expect(extractPdfText(part, { transfer: true })).rejects.toThrow(TypeError);
  });

  test('one unreadable page leaves that page empty with a warning; the PDF still reads', async () => {
    const good = new TextDecoder().decode(makePdf(['One', 'Two', 'Three']));
    const broken = good.replace(/6 0 obj\n<<[^\n]*>>\nendobj/, '6 0 obj\n42\nendobj');
    expect(broken).not.toBe(good);
    const pdf = await extractPdfText(new TextEncoder().encode(broken));
    expect(pdf.pages[0]?.text).toBe('One');
    expect(pdf.pages[1]?.text).toBe('');
    expect(pdf.pageCount).toBe(pdf.pages.length);
    expect(pdf.warnings).toEqual(['Page 2 could not be read; it has no text']);
    expect((await extractPdfText(makePdf(['Fine']))).warnings).toEqual([]);
  });

  test('page text loses NUL characters, which jsonb cannot store', () => {
    expect(cleanPageText('a\u0000b\u0000')).toBe('ab');
    expect(JSON.stringify(cleanPageText('x\u0000'))).not.toContain('\\u0000');
  });

  test('a file that is not a PDF is refused', async () => {
    await expect(extractPdfText(new TextEncoder().encode('not a pdf'))).rejects.toThrow(
      new ThreadInputError('The file could not be read as a PDF'),
    );
  });

  test('parsing runs in its own thread, bounded in time and stopped on abort', async () => {
    await expect(extractPdfText(makePdf(['Slow']), { timeoutMs: 1 })).rejects.toThrow(
      new ThreadInputError('Reading the PDF took too long'),
    );
    const controller = new AbortController();
    const pending = extractPdfText(makePdf(['Stopped']), { signal: controller.signal });
    controller.abort();
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    // An abort is not a problem with the file: the job retries it.
    expect(err).not.toBeInstanceOf(ThreadInputError);
  });
});

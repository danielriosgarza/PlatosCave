import {
  READING_HTML_ATTRIBUTES,
  READING_HTML_PROTOCOLS,
  READING_HTML_TAGS,
} from '@parallax/contracts';
import type { Element, Root } from 'hast';
import rehypeParse from 'rehype-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { describe, expect, test } from 'vitest';
// Shared with the browser layer's test, which runs these outputs through DOMPurify.
import hostile from '../../../web/src/reading/hostile-readings.json';
import { makePdf } from '../../test/fixtures/pdf';
import { extractPdfText, PdfReadError } from './pdf-text';
import {
  blockId,
  normaliseText,
  readingSchema,
  renderReading,
  resolveReadingImages,
} from './reading';

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

  test('a file that is not a PDF is refused', async () => {
    await expect(extractPdfText(new TextEncoder().encode('not a pdf'))).rejects.toThrow(
      new PdfReadError('The file could not be read as a PDF'),
    );
  });

  test('parsing runs in its own thread, bounded in time and stopped on abort', async () => {
    await expect(extractPdfText(makePdf(['Slow']), { timeoutMs: 1 })).rejects.toThrow(
      new PdfReadError('Reading the PDF took too long'),
    );
    const controller = new AbortController();
    const pending = extractPdfText(makePdf(['Stopped']), { signal: controller.signal });
    controller.abort();
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    // An abort is not a problem with the file: the job retries it.
    expect(err).not.toBeInstanceOf(PdfReadError);
  });
});

/** hast property name → HTML attribute name (`className` → `class`, `ariaLabel` → `aria-label`). */
const attributeName = (prop: string): string => {
  const special: Record<string, string> = {
    className: 'class',
    htmlFor: 'for',
    acceptCharset: 'accept-charset',
  };
  if (special[prop]) return special[prop];
  if (/^aria[A-Z]/.test(prop)) return `aria-${prop.slice(4).toLowerCase()}`;
  if (/^data[A-Z]/.test(prop)) return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return prop.toLowerCase();
};

/** Attributes the pipeline sets after sanitising (ids, link rel, the display-math class). */
const ADDED_AFTER_SANITISING: Record<string, string[]> = {
  '*': ['data-block-id', 'data-figure-id'],
  a: ['rel'],
  div: ['class'],
  img: ['data-object-key'],
};

/** Script, handlers, styles and script URLs in a parsed (browser-equivalent) tree. */
function dangers(tree: Root): string[] {
  const found: string[] = [];
  visit(tree, 'element', (el: Element) => {
    if (['script', 'style', 'iframe', 'object', 'embed', 'svg', 'form'].includes(el.tagName)) {
      found.push(el.tagName);
    }
    for (const [prop, value] of Object.entries(el.properties)) {
      if (/^on/i.test(prop) || prop === 'style') found.push(`${el.tagName}[${prop}]`);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: browsers drop these in a scheme
      const compact = String(value).replace(/[\u0000-\u0020\u007f]/g, '');
      if (/^(?:javascript|vbscript|data):/i.test(compact)) found.push(`${el.tagName}[${prop}]`);
    }
  });
  return found;
}

describe('reading HTML on the app origin (ADR-0002)', () => {
  test('the ingestion schema and the browser allow-list name the same elements and attributes', () => {
    expect([...(readingSchema.tagNames ?? [])].sort()).toEqual([...READING_HTML_TAGS].sort());
    const schema = readingSchema.attributes ?? {};
    const allowed = new Set(['*', ...READING_HTML_TAGS]);
    const tags = [...Object.keys(schema), ...Object.keys(READING_HTML_ATTRIBUTES)];
    // Attributes of an element the schema drops (`source`) never reach a page.
    for (const tag of new Set(tags.filter((t) => allowed.has(t)))) {
      const names = (schema[tag] ?? []).map((a) => attributeName(Array.isArray(a) ? a[0] : a));
      const expected = [...names, ...(ADDED_AFTER_SANITISING[tag] ?? [])];
      expect([...new Set(expected)].sort(), tag).toEqual(
        [...(READING_HTML_ATTRIBUTES[tag] ?? [])].sort(),
      );
    }
    for (const [attribute, schemes] of Object.entries(READING_HTML_PROTOCOLS)) {
      expect(readingSchema.protocols?.[attribute]).toEqual(schemes);
    }
  });

  test.each(hostile.cases)('$name: the shared fixture is what ingestion makes of it', (c) => {
    const { html } = renderReading(c.source, c.format as 'html' | 'markdown');
    // On a mismatch, regenerate `ingested` in hostile-readings.json from renderReading.
    expect(html).toBe(c.ingested);
    const tree = unified().use(rehypeParse, { fragment: true }).parse(html);
    expect(dangers(tree)).toEqual([]);
  });

  test('the benign fixture is what ingestion and image resolution make of it', () => {
    const { benign } = hostile;
    const { html } = renderReading(benign.source, 'markdown', benign.assets);
    expect(resolveReadingImages(html, () => benign.imageUrl)).toBe(benign.ingested);
  });
});

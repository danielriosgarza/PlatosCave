import { READING_HTML_ATTRIBUTES, READING_HTML_TAGS, READING_ID_PREFIX } from '@parallax/contracts';
import { describe, expect, test } from 'vitest';
import fixture from './hostile-readings.json';
import { sanitizeReading } from './sanitize';

/**
 * `hostile-readings.json` holds what the server's ingestion sanitiser makes of hostile sources
 * (`ingested`); `apps/server/src/content/reading.test.ts` re-renders every case and fails when the
 * file no longer matches the server, so these tests run the real output of the first layer.
 */

/**
 * How a browser parses the HTML inserted into the page (foreign content and all), in a document
 * that runs nothing, so a hostile source cannot fire a handler in the test itself.
 */
const inert = document.implementation.createHTMLDocument('');
function parse(html: string): HTMLElement {
  const root = inert.createElement('div');
  root.innerHTML = html;
  return root;
}

const URL_ATTRIBUTES = ['href', 'src', 'cite', 'action', 'formaction', 'xlink:href', 'data'];
const SCRIPT_URL = /^(?:javascript|vbscript|data):/i;
const RAW = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'template', 'form']);

/** Everything in the parsed DOM that could run script or restyle the app. */
function dangers(root: HTMLElement): string[] {
  const found: string[] = [];
  for (const el of root.querySelectorAll('*')) {
    const tag = el.localName;
    if (RAW.has(tag)) found.push(`<${tag}>`);
    if (!READING_HTML_TAGS.includes(tag)) found.push(`<${tag}> is not a reading element`);
    for (const { name, value } of el.attributes) {
      if (name.startsWith('on')) found.push(`${tag}[${name}]`);
      if (name === 'style') found.push(`${tag}[style]`);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: browsers drop these in a scheme
      const compact = value.replace(/[\u0000- \u007f]/g, '');
      if (URL_ATTRIBUTES.includes(name) && SCRIPT_URL.test(compact)) {
        found.push(`${tag}[${name}=${value}]`);
      }
      const allowed =
        READING_HTML_ATTRIBUTES['*']?.includes(name) ||
        READING_HTML_ATTRIBUTES[tag]?.includes(name);
      if (!allowed) found.push(`${tag}[${name}] is not a reading attribute`);
      if (name === 'id' && !value.startsWith(READING_ID_PREFIX)) found.push(`id=${value}`);
    }
  }
  return found;
}

describe('reading HTML on the app origin', () => {
  test.each(fixture.cases)(
    '$name: no script, handler or script URL survives both layers',
    ({ ingested }) => {
      const shown = sanitizeReading(ingested);
      expect(dangers(parse(shown))).toEqual([]);
      // Inserting the result and serialising it again changes nothing (no mutation on reparse).
      expect(sanitizeReading(parse(shown).innerHTML)).toBe(parse(shown).innerHTML);
    },
  );

  test.each(fixture.cases)('$name: the browser layer alone stops the raw source', ({ source }) => {
    expect(dangers(parse(source)).length).toBeGreaterThan(0);
    expect(dangers(parse(sanitizeReading(source)))).toEqual([]);
  });

  test('class and rel keep only the values the server schema allows', () => {
    const root = parse(
      sanitizeReading(
        '<code class="hljs language-r pc-shell">x</code><span class="katex evil">y</span>' +
          '<p class="anything">z</p><a href="https://ok.example" rel="noopener opener">l</a>',
      ),
    );
    expect(root.querySelector('code')?.className).toBe('hljs language-r');
    expect(root.querySelector('span')?.className).toBe('katex');
    expect(root.querySelector('p')?.hasAttribute('class')).toBe(false);
    expect(root.querySelector('a')?.getAttribute('rel')).toBe('noopener');
  });

  test('HTML inside a MathML text point keeps its text but loses links and handlers', () => {
    const mtext = fixture.cases[0];
    if (!mtext) throw new Error('no mtext case');
    const root = parse(sanitizeReading(mtext.ingested));
    expect(root.querySelector('mtext')?.textContent).toBe('xtext');
    expect(root.querySelector('a')?.hasAttribute('href')).toBe(false);
  });

  test('a real reading comes through the browser layer unchanged', () => {
    const { ingested } = fixture.benign;
    const before = parse(ingested);
    const after = parse(sanitizeReading(ingested));
    expect(dangers(before)).toEqual([]);
    expect(after.isEqualNode(before)).toBe(true);
    // The parts the reader and anchors rely on are all there.
    expect(after.querySelectorAll('[data-block-id]').length).toBeGreaterThan(10);
    expect(after.querySelector('figure[data-figure-id] img')?.getAttribute('src')).toBe(
      fixture.benign.imageUrl,
    );
    expect(after.querySelector('div.math-display math[display="block"] mfrac')).not.toBeNull();
    expect(after.querySelector('annotation')?.textContent).toBe('a^2');
    expect(after.querySelector('a[title="Note: a title"]')?.getAttribute('href')).toBe(
      'https://example.org',
    );
    expect(after.querySelector('input')?.outerHTML).toBe(
      '<input type="checkbox" checked="" disabled="">',
    );
  });
});

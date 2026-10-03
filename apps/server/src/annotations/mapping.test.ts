import type { Anchor } from '@parallax/contracts';
import { describe, expect, test } from 'vitest';
import {
  type Block,
  editDistance,
  type Layout,
  layoutOf,
  MAP_THRESHOLD,
  mapAnchor,
  similarity,
} from './mapping';

const paragraph =
  'Every sample tells a slightly different story, and the sampling distribution collects them.';
const other = 'A statistic computed from a sample is itself a random variable.';

const reading = (blocks: Block[], figures: string[] = []): Layout => ({
  type: 'reading_native',
  blocks,
  figures,
});
const v1 = reading([
  { id: 'aaaaaaaaaaaa', text: paragraph },
  { id: 'bbbbbbbbbbbb', text: other },
]);

/** A text anchor on `quote` inside `text`, with up to 32 characters of context each side. */
function textAnchor(blockId: string, text: string, quote: string): Anchor {
  const start = text.indexOf(quote);
  const end = start + quote.length;
  return {
    kind: 'text',
    blockId,
    start,
    end,
    quote,
    prefix: text.slice(Math.max(0, start - 32), start),
    suffix: text.slice(end, end + 32),
  };
}
const mark = textAnchor('aaaaaaaaaaaa', paragraph, 'sampling distribution');

const pdf = (hashes: string[]): Layout => ({ type: 'reading_pdf', pages: hashes });
const pageMark: Anchor = { kind: 'pdf', page: 1, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.05 } };

describe('A06 reflow- and zoom-invariant anchors', () => {
  test('A06 reflow: a reading whose blocks are unchanged keeps every anchor exactly', () => {
    // Reflow and Focus change line breaks on screen, never the block map; the anchor is the same.
    const reflowed = reading(v1.blocks?.map((b) => ({ ...b })) ?? []);
    expect(mapAnchor(mark, v1, reflowed)).toEqual({
      status: 'mapped',
      anchor: mark,
      confidence: 1,
    });
  });

  test('A06 zoom: PDF anchors are normalised page space, so unchanged pages keep them', () => {
    expect(mapAnchor(pageMark, pdf(['h0', 'h1']), pdf(['h0', 'h1']))).toEqual({
      status: 'mapped',
      anchor: pageMark,
      confidence: 1,
    });
  });
});

describe('A06 mapping a mark to a changed revision', () => {
  test('A06 a paragraph inserted before the passage still maps exactly by block id', () => {
    const v2 = reading([
      { id: 'cccccccccccc', text: 'A new opening paragraph.' },
      ...(v1.blocks ?? []),
    ]);
    expect(mapAnchor(mark, v1, v2)).toMatchObject({ status: 'mapped', confidence: 1 });
  });

  test('A06 an edited paragraph maps the quote to its new offsets and block', () => {
    const edited = `Note: ${paragraph.replace('slightly', 'somewhat')}`;
    const v2 = reading([{ id: 'dddddddddddd', text: edited }, v1.blocks?.[1] as Block]);
    const result = mapAnchor(mark, v1, v2);
    expect(result.status).toBe('mapped');
    if (result.status !== 'mapped' || result.anchor.kind !== 'text') throw new Error('unmapped');
    expect(result.anchor.blockId).toBe('dddddddddddd');
    expect(edited.slice(result.anchor.start, result.anchor.end)).toBe('sampling distribution');
    expect(result.confidence).toBeGreaterThanOrEqual(MAP_THRESHOLD);
    expect(result.confidence).toBeLessThan(1);
  });

  test('A06 a slightly reworded quote with intact context maps fuzzily', () => {
    const long = textAnchor(
      'aaaaaaaaaaaa',
      paragraph,
      'tells a slightly different story, and the sampling',
    );
    const v2 = reading([
      {
        id: 'eeeeeeeeeeee',
        text: paragraph.replace('tells a slightly different', 'tells a slightly diferent'),
      },
    ]);
    const result = mapAnchor(long, v1, v2);
    expect(result).toMatchObject({ status: 'mapped', anchor: { blockId: 'eeeeeeeeeeee' } });
  });

  test('A06 a re-wrapped paragraph keeps its id and maps exactly despite moved line breaks', () => {
    const wrapped =
      'Every sample tells\na slightly different story, and the\nsampling distribution collects them.';
    const rewrapped =
      'Every sample tells a slightly\ndifferent story, and the sampling distribution collects them.';
    // Same normalised text, so ingestion keeps the block id; only the raw line breaks moved.
    const before = reading([{ id: '333333333333', text: wrapped }]);
    const after = reading([{ id: '333333333333', text: rewrapped }]);
    const anchor = textAnchor('333333333333', wrapped, 'slightly different story');
    const result = mapAnchor(anchor, before, after);
    expect(result).toMatchObject({ status: 'mapped', confidence: 1 });
    if (result.status !== 'mapped' || result.anchor.kind !== 'text') throw new Error('unmapped');
    expect(rewrapped.slice(result.anchor.start, result.anchor.end)).toBe(
      'slightly\ndifferent story',
    );
  });

  test('A06 an edited quote that contains its own suffix text still maps', () => {
    const text = 'Lead: the mean and the median.';
    const anchor = textAnchor('444444444444', text, 'the mean and the median');
    // The edit puts the suffix text (".") inside the quote: the first "." is not the end.
    const edited = 'Lead: the mean. and the median.';
    const result = mapAnchor(anchor, v1, reading([{ id: '555555555555', text: edited }]));
    expect(result).toMatchObject({ status: 'mapped', anchor: { blockId: '555555555555' } });
    if (result.status !== 'mapped' || result.anchor.kind !== 'text') throw new Error('unmapped');
    expect(edited.slice(result.anchor.start, result.anchor.end)).toBe('the mean. and the median');
  });

  test('A06 a mapped quote never exceeds the anchor contract', () => {
    const long = 'x'.repeat(995);
    const text = `Lead in. ${long} middle ${long} Tail out.`;
    const quote = `${long} middle ${long}`; // 1998 characters
    const anchor = textAnchor('666666666666', text, quote);
    // The passage grows by 80 characters: similar enough, but too long to be an anchor quote.
    const grown = text.replace(' middle ', ` middle ${'y'.repeat(80)} `);
    const result = mapAnchor(anchor, v1, reading([{ id: '777777777777', text: grown }]));
    expect(result).toEqual({ status: 'needs_reattachment' });
  });

  test('A06 a removed passage needs reattachment instead of a guess', () => {
    const v2 = reading([{ id: 'ffffffffffff', text: 'Samples differ; that is the whole point.' }]);
    expect(mapAnchor(mark, v1, v2)).toEqual({ status: 'needs_reattachment' });
  });

  test('A06 a quote now appearing twice with equal context is ambiguous', () => {
    const v2 = reading([
      { id: '111111111111', text: paragraph },
      { id: '222222222222', text: `${paragraph} ` },
    ]);
    expect(mapAnchor(mark, v1, v2)).toEqual({ status: 'needs_reattachment' });
  });

  test('A06 a PDF page whose text changed, or a changed page count, needs reattachment', () => {
    expect(mapAnchor(pageMark, pdf(['h0', 'h1']), pdf(['h0', 'h1*']))).toEqual({
      status: 'needs_reattachment',
    });
    expect(mapAnchor(pageMark, pdf(['h0', 'h1']), pdf(['h0', 'h1', 'h2']))).toEqual({
      status: 'needs_reattachment',
    });
    // A page whose hash is missing on both sides is not a match.
    const unhashed = layoutOf('reading_pdf', { pages: [{ text: '' }, { text: '' }] });
    expect(mapAnchor(pageMark, unhashed, unhashed as Layout).status).toBe('needs_reattachment');
    // Without the original page hashes nothing can be compared.
    expect(mapAnchor(pageMark, undefined, pdf(['h0', 'h1'])).status).toBe('needs_reattachment');
  });

  test('A06 slides map like PDF pages; figures map while the figure id exists', () => {
    const deck = (pages: string[]): Layout => ({ type: 'slides_pdf', pages });
    const slide: Anchor = { kind: 'slide', page: 0 };
    expect(mapAnchor(slide, deck(['s0']), deck(['s0'])).status).toBe('mapped');
    expect(mapAnchor(slide, deck(['s0']), deck(['s0!'])).status).toBe('needs_reattachment');
    const figure: Anchor = {
      kind: 'figure',
      figureId: 'fig-1',
      strokes: [{ tool: 'pen', color: '#000000', width: 2, points: [[0.1, 0.1]] }],
    };
    expect(mapAnchor(figure, v1, reading([], ['fig-1'])).status).toBe('mapped');
    expect(mapAnchor(figure, v1, reading([], ['fig-2'])).status).toBe('needs_reattachment');
  });

  test('A24 a web deck slide maps while its text is unchanged and the slide count is the same', () => {
    const web = (texts: string[]) =>
      layoutOf('slides_web', {
        slides: texts.map((t) => `<p>${t}</p>`),
        blockMap: texts.map((text, i) => ({
          id: `${i}`.padStart(12, 'a'),
          tag: 'p',
          text,
          slide: i + 1,
        })),
      }) as Layout;
    const slide: Anchor = { kind: 'slide', page: 1 };
    const v1 = web(['Intro', 'Sampling  varies']);
    // Re-wrapped whitespace is the same text; the same slide in a new revision keeps its anchor.
    expect(mapAnchor(slide, v1, web(['Intro changed', 'Sampling varies']))).toMatchObject({
      status: 'mapped',
      anchor: slide,
    });
    expect(mapAnchor(slide, v1, web(['Intro', 'Sampling varies a lot'])).status).toBe(
      'needs_reattachment',
    );
    // An added slide shifts the numbering: nothing is guessed.
    expect(mapAnchor(slide, v1, web(['Intro', 'Sampling varies', 'New'])).status).toBe(
      'needs_reattachment',
    );
  });

  test('A06 an anchor that does not fit the new revision type needs reattachment', () => {
    expect(mapAnchor(mark, v1, pdf(['h0'])).status).toBe('needs_reattachment');
    expect(mapAnchor({ kind: 'none' }, v1, pdf(['h0'])).status).toBe('mapped');
  });
});

describe('layouts and similarity', () => {
  test('layoutOf reads P1-08 derived outputs and reports missing ones as not ready', () => {
    expect(
      layoutOf('reading_native', {
        blockMap: [{ id: 'aaaaaaaaaaaa', tag: 'p', text: 'x' }],
        figures: [{ id: 'fig-1', objectKey: null, alt: '', caption: '' }],
      }),
    ).toEqual({
      type: 'reading_native',
      blocks: [{ id: 'aaaaaaaaaaaa', text: 'x' }],
      figures: ['fig-1'],
    });
    expect(
      layoutOf('reading_pdf', { pageCount: 1, pages: [{ text: 'x', textHash: 'h' }] }),
    ).toEqual({ type: 'reading_pdf', pages: ['h'] });
    expect(layoutOf('reading_native', {})).toBeUndefined();
    expect(layoutOf('slides_pdf', { status: { state: 'running' } })).toBeUndefined();
    expect(layoutOf('exercise', {})).toEqual({ type: 'exercise' });
  });

  test('the banded edit distance agrees with the full one, or reports that it exceeds max', () => {
    const full = (a: string, b: string) => {
      const d = Array.from({ length: a.length + 1 }, (_, i) =>
        Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
      );
      for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
          const row = d[i] as number[];
          const up = d[i - 1] as number[];
          row[j] = Math.min(
            (up[j] ?? 0) + 1,
            (row[j - 1] ?? 0) + 1,
            (up[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
          );
        }
      }
      return d[a.length]?.[b.length] ?? 0;
    };
    let seed = 7;
    const random = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    const word = () =>
      Array.from({ length: Math.floor(random() * 30) }, () => 'abc'[Math.floor(random() * 3)]).join(
        '',
      );
    for (let n = 0; n < 500; n++) {
      const [a, b] = [word(), word()];
      const max = Math.floor(random() * 12);
      const expected = full(a, b);
      expect(editDistance(a, b)).toBe(expected);
      expect(editDistance(a, b, max)).toBe(expected <= max ? expected : max + 1);
    }
  });

  test('similarity ignores whitespace differences and counts edits', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(similarity('a  b\nc', 'a b c')).toBe(1);
    expect(similarity('abcdefghij', 'abcdefghiX')).toBeCloseTo(0.9);
  });
});

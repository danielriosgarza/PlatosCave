import { type Anchor, anchorFits } from '@parallax/contracts';

/**
 * Anchor mapping between two revisions of one resource (ADR-0003, §8, A06). Pure functions:
 * the job in `placements.ts` loads the revisions and stores the results. A mark is moved only
 * when the match is confident; otherwise it needs reattachment and keeps its original quote.
 */

/** Lowest normalised similarity accepted for a text anchor that is not an exact block match. */
export const MAP_THRESHOLD = 0.9;

/** Most candidate positions scored for one anchor; a quote this common is not identifying. */
const MAX_CANDIDATES = 100;
const CONTEXT = 32;

export interface Block {
  id: string;
  /** The block's text content; anchor offsets are code units in it. */
  text: string;
}

/**
 * What a revision offers anchors, from its derived outputs (P1-08, P2-01): text blocks and
 * figure ids for native readings and web slides, per-page text hashes for PDFs and decks.
 */
export interface Layout {
  type: string;
  blocks?: Block[];
  figures?: string[];
  /** Text hash per page; undefined for a page whose hash is missing. */
  pages?: (string | undefined)[];
}

export type Mapping =
  | { status: 'mapped'; anchor: Anchor; confidence: number }
  | { status: 'needs_reattachment' };

const needs: Mapping = { status: 'needs_reattachment' };
const exact = (anchor: Anchor): Mapping => ({ status: 'mapped', anchor, confidence: 1 });

const array = (value: unknown): unknown[] | undefined => (Array.isArray(value) ? value : undefined);
const str = (value: unknown): value is string => typeof value === 'string';

/**
 * The layout of a revision, or undefined while the derived outputs that anchors need are not
 * there yet (ingestion still running). Types that only take `none` anchors need nothing.
 */
export function layoutOf(type: string, derived: Record<string, unknown>): Layout | undefined {
  if (type === 'reading_native' || type === 'slides_web') {
    const blocks = array(derived.blockMap)?.flatMap((b) => {
      const { id, text } = (b ?? {}) as Record<string, unknown>;
      return str(id) && str(text) ? [{ id, text }] : [];
    });
    if (!blocks) return undefined;
    const figures = (array(derived.figures) ?? []).flatMap((f) => {
      const { id } = (f ?? {}) as Record<string, unknown>;
      return str(id) ? [id] : [];
    });
    return { type, blocks, figures };
  }
  if (type === 'reading_pdf' || type === 'slides_pdf') {
    // A page without a text hash can never match: `undefined` compares unequal below.
    const pages = array(derived.pages)?.map((p) => {
      const { textHash } = (p ?? {}) as Record<string, unknown>;
      return str(textHash) ? textHash : undefined;
    });
    return pages ? { type, pages } : undefined;
  }
  return { type };
}

/** Whitespace-collapsed NFC text, as block ids and page hashes are computed (ADR-0003). */
export const normaliseText = (text: string): string =>
  text.normalize('NFC').replace(/\s+/g, ' ').trim();

/** Edit distance with two rows; inputs are bounded by the anchor schema (≤ 2000 + 2 × 32). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let next = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    next[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      next[j] = Math.min((prev[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, next] = [next, prev];
  }
  return prev[b.length] ?? 0;
}

/** 1 − edit distance / longer length, over normalised text. */
export function similarity(a: string, b: string): number {
  const [x, y] = [normaliseText(a), normaliseText(b)];
  const longest = Math.max(x.length, y.length);
  return longest === 0 ? 1 : 1 - editDistance(x, y) / longest;
}

function occurrences(text: string, needle: string, limit: number): number[] {
  const found: number[] = [];
  for (let i = text.indexOf(needle); i !== -1 && found.length < limit; ) {
    found.push(i);
    i = text.indexOf(needle, i + 1);
  }
  return found;
}

type TextAnchor = Extract<Anchor, { kind: 'text' }>;
interface Candidate {
  block: Block;
  start: number;
  end: number;
}

/**
 * Positions that could hold the quote: every exact occurrence in any block, or, when the quote
 * itself was edited, the text between an occurrence of its prefix and the next suffix.
 */
function candidates(anchor: TextAnchor, blocks: Block[]): Candidate[] {
  const { quote, prefix, suffix } = anchor;
  const found: Candidate[] = [];
  for (const block of blocks) {
    for (const start of occurrences(block.text, quote, MAX_CANDIDATES + 1 - found.length)) {
      found.push({ block, start, end: start + quote.length });
    }
    if (found.length > MAX_CANDIDATES) return found;
  }
  if (found.length > 0 || (prefix === '' && suffix === '')) return found;
  const longest = Math.ceil(quote.length / MAP_THRESHOLD);
  for (const block of blocks) {
    const { text } = block;
    const starts = prefix
      ? occurrences(text, prefix, MAX_CANDIDATES).map((i) => i + prefix.length)
      : [0];
    for (const start of starts) {
      const end = suffix ? text.indexOf(suffix, start + 1) : text.length;
      if (end > start && end - start <= longest) found.push({ block, start, end });
      if (found.length > MAX_CANDIDATES) return found;
    }
  }
  return found;
}

/**
 * Similarity of the original quote with its context to a candidate with the same amount of
 * context around it, so a moved passage with intact surroundings scores 1.
 */
function score(anchor: TextAnchor, { block, start, end }: Candidate): number {
  const { text } = block;
  const before = text.slice(Math.max(0, start - anchor.prefix.length), start);
  const after = text.slice(end, end + anchor.suffix.length);
  return similarity(
    anchor.prefix + anchor.quote + anchor.suffix,
    before + text.slice(start, end) + after,
  );
}

function mapText(anchor: TextAnchor, blocks: Block[]): Mapping {
  const same = blocks.find((b) => b.id === anchor.blockId);
  if (same && same.text.slice(anchor.start, anchor.end) === anchor.quote) return exact(anchor);

  const found = candidates(anchor, blocks);
  if (found.length === 0 || found.length > MAX_CANDIDATES) return needs;
  const accepted = found
    .map((c) => ({ ...c, score: score(anchor, c) }))
    .filter((c) => c.score >= MAP_THRESHOLD);
  // Two plausible places is a guess, and the spec says not to guess (§8).
  if (accepted.length !== 1 || !accepted[0]) return needs;
  const { block, start, end, score: confidence } = accepted[0];
  const quote = block.text.slice(start, end);
  return {
    status: 'mapped',
    confidence: Math.round(confidence * 1000) / 1000,
    anchor: {
      kind: 'text',
      blockId: block.id,
      start,
      end,
      quote,
      prefix: block.text.slice(Math.max(0, start - CONTEXT), start),
      suffix: block.text.slice(end, end + CONTEXT),
    },
  };
}

/**
 * Maps `anchor`, made on a revision with layout `from`, onto a revision with layout `to`.
 * PDF pages and slides keep their anchor only when the page count and that page's text hash
 * are unchanged; figures when the figure id still exists; text by block id and quote, then by
 * a unique fuzzy match of quote and context.
 */
export function mapAnchor(anchor: Anchor, from: Layout | undefined, to: Layout): Mapping {
  if (!anchorFits(to.type, anchor)) return needs;
  switch (anchor.kind) {
    case 'none':
      return exact(anchor);
    case 'figure':
      return to.figures?.includes(anchor.figureId) ? exact(anchor) : needs;
    case 'pdf':
    case 'slide': {
      const [before, after] = [from?.pages, to.pages];
      if (!before || !after || before.length !== after.length) return needs;
      const hash = before[anchor.page];
      return hash !== undefined && hash === after[anchor.page] ? exact(anchor) : needs;
    }
    case 'text':
      return to.blocks ? mapText(anchor, to.blocks) : needs;
  }
}

import { type Anchor, anchorFits, type ResourceType, textAnchor } from '@parallax/contracts';
// The one definition ingestion uses for block ids and page hashes, so recomputed ids match.
import { normaliseText } from '../content/text';

/**
 * Anchor mapping between two revisions of one resource (ADR-0003, §8, A06). Pure functions:
 * the `annotations.map` job loads the revisions and `annotations.ts` stores the results. A mark is moved only
 * when the match is confident; otherwise it needs reattachment and keeps its original quote.
 */

/** Lowest normalised similarity accepted for a text anchor that is not an exact block match. */
export const MAP_THRESHOLD = 0.9;

/** Most candidate positions scored for one anchor; a quote this common is not identifying. */
const MAX_CANDIDATES = 100;
const CONTEXT = 32;
/** Longest quote a text anchor may carry (`textAnchor` in the contracts). */
const MAX_QUOTE = 2000;

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
  type: ResourceType;
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

/** The state of the job deriving a revision's outputs, if one is recorded (`DerivedStatus`). */
const stateOf = (derived: Record<string, unknown>): unknown =>
  (derived.status as { state?: unknown } | null | undefined)?.state;

/**
 * The layout of a revision, or `pending` while the job producing the derived outputs anchors
 * need is queued or running, so mapping waits for it. When no job will produce them (it
 * failed, or none was ever recorded), the layout has none: those marks need reattachment
 * rather than waiting forever. Types that only take `none` anchors need nothing.
 */
export function layoutOf(type: ResourceType, derived: Record<string, unknown>): Layout | 'pending' {
  const layout = outputsOf(type, derived);
  if (layout) return layout;
  const state = stateOf(derived);
  return state === 'queued' || state === 'running' ? 'pending' : { type };
}

/** The layout from derived outputs (P1-08, P2-01, P2-03), or undefined when they are missing. */
function outputsOf(type: ResourceType, derived: Record<string, unknown>): Layout | undefined {
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

/**
 * Edit distance, or `max + 1` once it is certain to exceed `max`. Shared leading and trailing
 * text is stripped first (it never changes the distance), then only the diagonal band of width
 * `max` is computed, so near-identical passages cost little whatever their length.
 */
export function editDistance(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  let [lo, hiA, hiB] = [0, a.length, b.length];
  while (lo < hiA && lo < hiB && a.charCodeAt(lo) === b.charCodeAt(lo)) lo++;
  while (hiA > lo && hiB > lo && a.charCodeAt(hiA - 1) === b.charCodeAt(hiB - 1))
    [hiA, hiB] = [hiA - 1, hiB - 1];
  const [x, y] = [a.slice(lo, hiA), b.slice(lo, hiB)];
  if (Math.abs(x.length - y.length) > max) return max + 1;
  if (x.length === 0 || y.length === 0) return Math.max(x.length, y.length);
  const band = Number.isFinite(max) ? max : Math.max(x.length, y.length);
  const over = band + 1;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => (j <= band ? j : over));
  let next = new Array<number>(y.length + 1);
  for (let i = 1; i <= x.length; i++) {
    const from = Math.max(1, i - band);
    const to = Math.min(y.length, i + band);
    // Cells just outside the band read as `over`; cells further out are never read.
    next[0] = i <= band ? i : over;
    next[from - 1] = from === 1 ? next[0] : over;
    if (to < y.length) next[to + 1] = over;
    let best = from === 1 ? next[0] : over;
    for (let j = from; j <= to; j++) {
      const cost = x.charCodeAt(i - 1) === y.charCodeAt(j - 1) ? 0 : 1;
      const value = Math.min(
        (prev[j] ?? over) + 1,
        (next[j - 1] ?? over) + 1,
        (prev[j - 1] ?? over) + cost,
      );
      next[j] = value;
      if (value < best) best = value;
    }
    if (best > band) return max + 1;
    [prev, next] = [next, prev];
  }
  const distance = prev[y.length] ?? over;
  return distance > band ? max + 1 : distance;
}

/**
 * 1 − edit distance / longer length, over normalised text. With `atLeast`, a pair whose length
 * difference alone keeps it below that similarity returns 0 without computing the distance.
 */
export function similarity(a: string, b: string, atLeast = 0): number {
  const [x, y] = [normaliseText(a), normaliseText(b)];
  if (x === y) return 1;
  const longest = Math.max(x.length, y.length);
  // The largest distance that still reaches `atLeast`; beyond it the pair scores 0.
  const allowed = atLeast > 0 ? Math.floor((1 - atLeast) * longest + 1e-9) : longest;
  // Narrow bands first: the usual candidate differs by a few characters, costing O(n · k).
  for (const band of [8, 64, allowed]) {
    const k = Math.min(band, allowed);
    const distance = editDistance(x, y, k);
    if (distance <= k) return 1 - distance / longest;
    if (k === allowed) break;
  }
  return 0;
}

/**
 * `text` with every whitespace run collapsed to one space, as block ids are computed (ADR-0003),
 * and for each of its characters the raw offset it came from, so a match `[start, end)` found
 * in `norm` maps back to raw `[raw[start], raw[end - 1] + 1)` (`toRaw`).
 */
interface Collapsed {
  norm: string;
  raw: number[];
}
function collapse(text: string): Collapsed {
  let norm = '';
  const raw: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const space = /\s/.test(text.charAt(i));
    if (space && i > 0 && /\s/.test(text.charAt(i - 1))) continue;
    norm += space ? ' ' : text.charAt(i);
    raw.push(i);
  }
  return { norm, raw };
}

/** Raw offsets of the non-empty collapsed range `[start, end)`. */
function toRaw({ raw }: Collapsed, start: number, end: number): [number, number] | undefined {
  const [first, last] = [raw[start], raw[end - 1]];
  return first === undefined || last === undefined || end <= start ? undefined : [first, last + 1];
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
  /** Candidates sharing a key are alternatives for one place; only the best one counts. */
  key: string;
}

/**
 * Positions that could hold the quote, found in whitespace-collapsed text so a re-wrapped
 * paragraph still matches: every exact occurrence, and, as the quote may have been edited, the
 * text between each occurrence of its prefix and each reachable occurrence of its suffix. Both
 * kinds are always collected, so an edited passage in its own context competes with a verbatim
 * copy elsewhere and scoring decides. Offsets are raw. Null when either kind is too common to
 * be identifying.
 */
function candidates(anchor: TextAnchor, blocks: Block[]): Candidate[] | null {
  const [quote, prefix, suffix] = [anchor.quote, anchor.prefix, anchor.suffix].map(
    (t) => collapse(t).norm,
  ) as [string, string, string];
  const longest = Math.min(Math.ceil(quote.length / MAP_THRESHOLD), MAX_QUOTE);
  const found: Candidate[] = [];
  let [exactCount, contextCount] = [0, 0];
  for (const block of blocks) {
    const c = collapse(block.text);
    const add = (start: number, end: number) => {
      const range = toRaw(c, start, end);
      if (range)
        found.push({ block, start: range[0], end: range[1], key: `${block.id}:${range[0]}` });
    };
    if (quote !== '') {
      for (const start of occurrences(c.norm, quote, MAX_CANDIDATES + 1)) {
        add(start, start + quote.length);
        exactCount += 1;
      }
      if (exactCount > MAX_CANDIDATES) return null;
    }
    if (prefix === '' && suffix === '') continue;
    const starts = prefix
      ? occurrences(c.norm, prefix, MAX_CANDIDATES + 1).map((i) => i + prefix.length)
      : [0];
    for (const start of starts) {
      // Every suffix occurrence in reach: the edited quote may itself contain the suffix text.
      const ends = suffix
        ? occurrences(
            c.norm.slice(start + 1, start + longest + suffix.length),
            suffix,
            MAX_CANDIDATES,
          )
            .map((i) => start + 1 + i)
            .filter((end) => end - start <= longest)
        : [c.norm.length].filter((end) => end > start && end - start <= longest);
      for (const end of ends) add(start, end);
      contextCount += ends.length;
      if (contextCount > MAX_CANDIDATES) return null;
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
    MAP_THRESHOLD,
  );
}

/** A text anchor on `block` from `start` to `end`, if it satisfies the anchor contract. */
function textAt(block: Block, start: number, end: number): Anchor | undefined {
  const parsed = textAnchor.safeParse({
    kind: 'text',
    blockId: block.id,
    start,
    end,
    quote: block.text.slice(start, end),
    prefix: block.text.slice(Math.max(0, start - CONTEXT), start),
    suffix: block.text.slice(end, end + CONTEXT),
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * The quote inside its own block, whose id proves the normalised text is unchanged (ADR-0003):
 * only whitespace may differ, as when a Markdown paragraph is re-wrapped.
 */
function withinSameBlock(anchor: TextAnchor, block: Block): Anchor | undefined {
  const collapsed = collapse(block.text);
  const quote = collapse(anchor.quote).norm;
  const at = collapsed.norm.indexOf(quote);
  if (quote.trim() === '' || at === -1 || collapsed.norm.indexOf(quote, at + 1) !== -1) {
    return undefined;
  }
  const range = toRaw(collapsed, at, at + quote.length);
  return range ? textAt(block, ...range) : undefined;
}

function mapText(anchor: TextAnchor, blocks: Block[]): Mapping {
  const same = blocks.find((b) => b.id === anchor.blockId);
  if (same) {
    if (same.text.slice(anchor.start, anchor.end) === anchor.quote) return exact(anchor);
    const moved = withinSameBlock(anchor, same);
    if (moved) return { status: 'mapped', anchor: moved, confidence: 1 };
  }

  const found = candidates(anchor, blocks);
  if (!found || found.length === 0) return needs;
  const best = new Map<string, Candidate & { score: number }>();
  for (const c of found) {
    const scored = { ...c, score: score(anchor, c) };
    const held = best.get(c.key);
    if (scored.score >= MAP_THRESHOLD && (!held || scored.score > held.score))
      best.set(c.key, scored);
  }
  const accepted = [...best.values()];
  // Two plausible places is a guess, and the spec says not to guess (§8).
  if (accepted.length !== 1 || !accepted[0]) return needs;
  const { block, start, end, score: confidence } = accepted[0];
  const placed = textAt(block, start, end);
  if (!placed) return needs;
  return { status: 'mapped', confidence: Math.round(confidence * 1000) / 1000, anchor: placed };
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

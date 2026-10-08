import type { Anchor } from '@parallax/contracts';

export type TextAnchor = Extract<Anchor, { kind: 'text' }>;

const CONTEXT = 32;
const QUOTE_MAX = 2000;

const blockOf = (node: Node | null): HTMLElement | null => {
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  return element?.closest<HTMLElement>('[data-block-id]') ?? null;
};

/** Code-unit offset of a boundary point in the block's text content. */
function offsetIn(block: HTMLElement, container: Node, offset: number): number {
  const before = document.createRange();
  before.selectNodeContents(block);
  before.setEnd(container, offset);
  return before.toString().length;
}

export interface SelectedPassage {
  anchor: TextAnchor;
  /** The block the passage sits in; the Highlight/Note/Ask toolbar follows it in the flow. */
  block: HTMLElement;
}

/**
 * The `text` anchor (§8, ADR-0003) for what is selected inside `root`: the block id, the code-unit
 * offsets in that block's text, the quote and a little context either side. An anchor names one
 * block, so a selection that runs into the next block is cut at the end of the first. Surrounding
 * whitespace is left out of the quote. Null when nothing usable is selected.
 */
export function passageFromSelection(
  root: HTMLElement,
  selection: Selection,
): SelectedPassage | null {
  if (selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const block = blockOf(range.startContainer);
  const blockId = block?.dataset.blockId;
  if (!block || !blockId) return null;
  const text = block.textContent ?? '';
  const start = offsetIn(block, range.startContainer, range.startOffset);
  const sameBlock = blockOf(range.endContainer) === block;
  let end = sameBlock ? offsetIn(block, range.endContainer, range.endOffset) : text.length;
  end = Math.min(end, start + QUOTE_MAX, text.length);
  const from = start + (text.slice(start, end).length - text.slice(start, end).trimStart().length);
  const to = end - (text.slice(from, end).length - text.slice(from, end).trimEnd().length);
  if (to <= from) return null;
  return {
    block,
    anchor: {
      kind: 'text',
      blockId,
      start: from,
      end: to,
      quote: text.slice(from, to),
      prefix: text.slice(Math.max(0, from - CONTEXT), from),
      suffix: text.slice(to, to + CONTEXT),
    },
  };
}

export type MarkKind = 'note' | 'highlight' | 'question';

export interface MarkSource {
  id: string;
  anchor: TextAnchor;
  kind: MarkKind;
}

const MARK = 'mark[data-marks]';
/**
 * Where the descriptions of a reading's marks live: outside the reading, so its text (and block
 * offsets) stay as they were.
 */
const holders = new WeakMap<HTMLElement, HTMLElement>();
let descriptionCount = 0;

/** What a mark holds, said after its text: "highlight", or "2 entries: note, question". */
const describe = (kinds: readonly MarkKind[]) =>
  kinds.length > 1 ? `${kinds.length} entries: ${kinds.join(', ')}` : (kinds[0] ?? '');

const blockById = (root: HTMLElement, blockId: string) =>
  [...root.querySelectorAll<HTMLElement>('[data-block-id]')].find(
    (b) => b.dataset.blockId === blockId,
  ) ?? null;

/** Takes every mark out again, leaving the reading's text as it was. */
export function clearMarks(root: HTMLElement) {
  holders.get(root)?.remove();
  holders.delete(root);
  for (const mark of root.querySelectorAll(MARK)) {
    const parent = mark.parentNode;
    mark.replaceWith(...mark.childNodes);
    parent?.normalize();
  }
}

/**
 * Marks the passages of `sources` in the rendered reading. Where passages overlap, each stretch of
 * text covered by several is one mark that lists them all and carries their count (`data-count`,
 * drawn by CSS so the reading's text is not changed and block offsets stay valid). Marks sit in
 * the existing text and never alter `textContent`.
 */
export function applyMarks(root: HTMLElement, sources: readonly MarkSource[]) {
  clearMarks(root);
  const byBlock = new Map<string, MarkSource[]>();
  for (const source of sources) {
    byBlock.set(source.anchor.blockId, [...(byBlock.get(source.anchor.blockId) ?? []), source]);
  }
  for (const [blockId, list] of byBlock) {
    const block = blockById(root, blockId);
    if (!block) continue;
    markBlock(root, block, list);
  }
}

function markBlock(root: HTMLElement, block: HTMLElement, list: readonly MarkSource[]) {
  const length = block.textContent?.length ?? 0;
  const bounds = new Set<number>();
  for (const { anchor } of list) {
    bounds.add(Math.min(anchor.start, length));
    bounds.add(Math.min(anchor.end, length));
  }
  const cuts = [...bounds].sort((a, b) => a - b);
  const segments: { start: number; end: number; ids: string[]; kinds: MarkKind[] }[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const start = cuts[i] as number;
    const end = cuts[i + 1] as number;
    const covering = list.filter((s) => s.anchor.start <= start && s.anchor.end >= end);
    if (covering.length > 0) {
      segments.push({
        start,
        end,
        ids: covering.map((s) => s.id),
        kinds: covering.map((s) => s.kind),
      });
    }
  }
  if (segments.length === 0) return;

  const nodes: { node: Text; start: number }[] = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let offset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push({ node: node as Text, start: offset });
    offset += (node as Text).length;
  }
  // A passage that crosses inline elements is several marks; only its first is a tab stop and
  // carries the name, so a screen reader meets the passage once and reads its words.
  const named = new Set<(typeof segments)[number]>();
  const descriptions = document.createDocumentFragment();
  for (const { node, start } of nodes) {
    const size = node.length;
    // Last piece first: splitting leaves the head in `node`, so earlier offsets stay valid.
    const pieces = segments
      .filter((s) => s.start < start + size && s.end > start)
      .sort((a, b) => b.start - a.start);
    for (const piece of pieces) {
      const from = Math.max(piece.start, start) - start;
      const to = Math.min(piece.end, start + size) - start;
      if (to < node.length) node.splitText(to);
      const target = from > 0 ? node.splitText(from) : node;
      const mark = document.createElement('mark');
      mark.dataset.marks = piece.ids.join(' ');
      if (piece.ids.length > 1) mark.dataset.count = String(piece.ids.length);
      if (!named.has(piece)) {
        named.add(piece);
        mark.tabIndex = 0;
        mark.setAttribute('role', 'button');
        // The marked words stay the name; what the mark holds is its description.
        const description = document.createElement('span');
        description.id = `mark-description-${++descriptionCount}`;
        description.textContent = describe(piece.kinds);
        descriptions.append(description);
        mark.setAttribute('aria-describedby', description.id);
      }
      target.replaceWith(mark);
      mark.append(target);
    }
  }
  if (descriptions.childElementCount > 0) {
    let holder = holders.get(root);
    if (!holder) {
      holder = document.createElement('div');
      holder.hidden = true;
      document.body.append(holder);
      holders.set(root, holder);
    }
    holder.append(descriptions);
  }
}

/** The ids listed by a mark, from the mark or anything inside it. */
export const marksAt = (target: EventTarget | null): string[] | null => {
  const mark = target instanceof Element ? target.closest<HTMLElement>(MARK) : null;
  return mark?.dataset.marks?.split(' ') ?? null;
};

/** Emphasises the marks that hold `id` and scrolls the first into view; returns it. */
export function activateMarks(root: HTMLElement, id: string | null): HTMLElement | null {
  let first: HTMLElement | null = null;
  for (const mark of root.querySelectorAll<HTMLElement>(MARK)) {
    const active = id !== null && (mark.dataset.marks?.split(' ').includes(id) ?? false);
    if (active) {
      mark.dataset.active = 'true';
      first ??= mark;
    } else {
      delete mark.dataset.active;
    }
  }
  return first;
}

/** Where a passage starts, as a distance below the top of `container` (for aligning the margin). */
export function firstMarkTop(root: HTMLElement, id: string): number | null {
  for (const mark of root.querySelectorAll<HTMLElement>(MARK)) {
    if (mark.dataset.marks?.split(' ').includes(id)) return mark.getBoundingClientRect().top;
  }
  return null;
}

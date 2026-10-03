import { afterEach, describe, expect, it } from 'vitest';
import { activateMarks, applyMarks, clearMarks, marksAt, passageFromSelection } from './anchors';

const A = '0123456789ab';
const B = '0123456789cd';

function reading() {
  const root = document.createElement('div');
  root.innerHTML = `<p data-block-id="${A}">Wider samples vary <em>less</em> than narrow ones do.</p><p data-block-id="${B}">The second block.</p>`;
  document.body.append(root);
  return root;
}

function select(from: Node, fromOffset: number, to: Node, toOffset: number): Selection {
  const selection = window.getSelection() as Selection;
  const range = document.createRange();
  range.setStart(from, fromOffset);
  range.setEnd(to, toOffset);
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

afterEach(() => {
  document.body.innerHTML = '';
  window.getSelection()?.removeAllRanges();
});

describe('selection to text anchor', () => {
  it('A05 records block id, offsets, quote and context for a range inside one block', () => {
    const root = reading();
    const text = root.querySelector('p')?.firstChild as Text;
    const found = passageFromSelection(root, select(text, 6, text, 13));
    expect(found?.anchor).toEqual({
      kind: 'text',
      blockId: A,
      start: 6,
      end: 13,
      quote: 'samples',
      prefix: 'Wider ',
      suffix: ' vary less than narrow ones do.',
    });
  });

  it('A05 counts offsets through inline elements and leaves out surrounding whitespace', () => {
    const root = reading();
    const p = root.querySelector('p') as HTMLElement;
    const first = p.firstChild as Text;
    const tail = p.lastChild as Text;
    // From " vary " through the end of " than " across <em>.
    const found = passageFromSelection(root, select(first, 13, tail, 6));
    expect(found?.anchor.quote).toBe('vary less than');
    expect(found?.anchor.start).toBe(p.textContent?.indexOf('vary'));
    expect(p.textContent?.slice(found?.anchor.start, found?.anchor.end)).toBe('vary less than');
  });

  it('A05 cuts a selection that runs into the next block at the end of the first', () => {
    const root = reading();
    const [one, two] = [...root.querySelectorAll('p')];
    const found = passageFromSelection(
      root,
      select(one?.firstChild as Text, 6, two?.firstChild as Text, 3),
    );
    expect(found?.anchor.blockId).toBe(A);
    expect(found?.anchor.end).toBe(one?.textContent?.length);
    expect(found?.block).toBe(one);
  });

  it('ignores a collapsed selection, whitespace only, and text outside the reading', () => {
    const root = reading();
    const text = root.querySelector('p')?.firstChild as Text;
    expect(passageFromSelection(root, select(text, 3, text, 3))).toBeNull();
    expect(passageFromSelection(root, select(text, 5, text, 6))).toBeNull();
    const other = document.createElement('p');
    other.textContent = 'Elsewhere';
    document.body.append(other);
    expect(
      passageFromSelection(root, select(other.firstChild as Text, 0, other.firstChild as Text, 5)),
    ).toBeNull();
  });
});

describe('marks', () => {
  const anchor = (id: string, start: number, end: number, blockId = A) => ({
    id,
    anchor: {
      kind: 'text' as const,
      blockId,
      start,
      end,
      quote: 'q',
      prefix: '',
      suffix: '',
    },
  });

  it('A05 marks a passage across inline elements without changing the text', () => {
    const root = reading();
    const before = root.textContent;
    applyMarks(root, [anchor('n1', 6, 23)]);
    const marks = [...root.querySelectorAll('mark[data-marks]')];
    expect(marks.length).toBeGreaterThan(1);
    expect(marks.map((m) => m.textContent).join('')).toBe('samples vary less');
    expect(root.textContent).toBe(before);
    expect(marks.every((m) => m.getAttribute('data-count') === null)).toBe(true);
  });

  it('A05 a location marked more than once shows a count and lists every entry', () => {
    const root = reading();
    applyMarks(root, [anchor('n1', 0, 6), anchor('n2', 3, 6), anchor('n3', 3, 6, B)]);
    const counted = root.querySelector('mark[data-count]') as HTMLElement;
    expect(counted.dataset.count).toBe('2');
    expect(counted.textContent).toBe('er ');
    expect(marksAt(counted)).toEqual(['n1', 'n2']);
    // The count is drawn by CSS from the attribute, so it is not part of the text.
    expect(root.textContent).toContain('Wider samples');
    expect(root.querySelector(`[data-block-id="${B}"] mark`)?.textContent).toBe(' se');
  });

  it('re-applying replaces marks, and clearing leaves the original text', () => {
    const root = reading();
    const html = root.innerHTML;
    applyMarks(root, [anchor('n1', 0, 5)]);
    applyMarks(root, [anchor('n2', 6, 13)]);
    expect([...root.querySelectorAll('mark')].map((m) => m.getAttribute('data-marks'))).toEqual([
      'n2',
    ]);
    clearMarks(root);
    expect(root.innerHTML).toBe(html);
  });

  it('activates the marks of one entry and finds the first', () => {
    const root = reading();
    applyMarks(root, [anchor('n1', 0, 5), anchor('n2', 6, 13)]);
    const first = activateMarks(root, 'n2');
    expect(first?.textContent).toBe('samples');
    expect(root.querySelectorAll('mark[data-active="true"]')).toHaveLength(1);
    expect(activateMarks(root, null)).toBeNull();
    expect(root.querySelector('mark[data-active]')).toBeNull();
  });
});

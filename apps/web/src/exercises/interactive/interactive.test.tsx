import '@testing-library/jest-dom/vitest';
import {
  type ExerciseStep,
  exerciseStep,
  exerciseStepView,
  judge,
  parseResponse,
  viewStep,
} from '@parallax/contracts';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type InteractiveDraft, interactiveDraft, interactiveResponse, snapParam } from './draft';
import { InteractiveForm } from './InteractiveForm';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const feedback = { correct: 'Right.', incorrect: 'Not yet.' };
const plane = { x: [-5, 5], y: [-5, 5], axes: true, grid: 1 };

/**
 * One interactive step answered in the student view and checked with the server's own rules,
 * so a keyboard path is followed from the first key to the judgement.
 */
function Harness({ raw, response }: { raw: Record<string, unknown>; response?: unknown }) {
  const step: ExerciseStep = exerciseStep.parse({
    id: 's',
    title: 'Step',
    prompt: 'Answer.',
    feedback,
    ...raw,
  });
  const view = exerciseStepView.parse(viewStep(step, 3)).interactive;
  if (!view) throw new Error('not an interactive step');
  const [draft, setDraft] = useState<InteractiveDraft>(() => interactiveDraft(view, response));
  const [said, setSaid] = useState('');
  const [parts, setParts] = useState<Record<string, boolean> | null>(null);
  const check = () => {
    const built = interactiveResponse(view, draft);
    if (!built.ok) return setSaid(built.message);
    const parsed = parseResponse(step, built.response);
    if (!parsed.ok) return setSaid(parsed.message);
    const judged = judge(step, parsed.value);
    setParts(judged.parts ?? null);
    setSaid(`${judged.correct ? 'Correct' : 'Not yet'}: ${judged.feedback}`);
  };
  return (
    <>
      <InteractiveForm
        view={view}
        draft={draft}
        disabled={false}
        parts={parts}
        label="Step"
        onChange={(next) => {
          setDraft(next);
          setParts(null);
        }}
      />
      <button type="button" onClick={check}>
        Check
      </button>
      <output aria-label="Result">{said}</output>
    </>
  );
}

const result = () => screen.getByRole('status', { name: 'Result' });

describe('interactive steps from the keyboard', () => {
  it('A20 sorts items into groups by picking each one and choosing its group', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        raw={{
          kind: 'categorize',
          categories: [
            { id: 'counted', label: 'Counted' },
            { id: 'measured', label: 'Measured' },
          ],
          items: [
            { id: 'goals', label: 'Goals', category: 'counted' },
            { id: 'height', label: 'Height', category: 'measured' },
          ],
          marks: true,
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(result()).toHaveTextContent('Sort every item into a group before checking.');

    screen.getByRole('button', { name: 'Goals' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Goals' })).toHaveAttribute('aria-pressed', 'true');
    // A picked item offers a "Put … in …" button in every group; Escape puts it down again.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: /^Put Goals/ })).toBeNull();
    screen.getByRole('button', { name: 'Goals' }).focus();
    await user.keyboard('{Enter}');
    screen.getByRole('button', { name: 'Put Goals in the group Measured' }).focus();
    await user.keyboard('{Enter}');
    screen.getByRole('button', { name: 'Height' }).focus();
    await user.keyboard('{Enter}');
    screen.getByRole('button', { name: 'Put Height in the group Counted' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('Every item is in a group.')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(result()).toHaveTextContent('Not yet');
    // Marked parts are named, not only drawn.
    const measured = screen.getByRole('region', { name: 'Group Measured' });
    expect(within(measured).getByRole('button', { name: 'Goals, not right yet' })).toBeVisible();

    // A placed item moves on to another group the same way.
    within(measured).getByRole('button', { name: /Goals/ }).focus();
    await user.keyboard('{Enter}');
    screen.getByRole('button', { name: 'Put Goals in the group Counted' }).focus();
    await user.keyboard('{Enter}');
    screen.getByRole('button', { name: 'Height' }).focus();
    await user.keyboard('{Enter}');
    screen.getByRole('button', { name: 'Put Height in the group Measured' }).focus();
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(result()).toHaveTextContent('Correct: Right.');
  });

  it('A20 fills gaps with tiles, and a placed tile goes back to the tiles', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        raw={{
          kind: 'fill_blanks',
          text: 'The standard error is σ over [[root]].',
          gaps: [{ id: 'root', answer: 'sqrt' }],
          tiles: [
            { id: 'sqrt', label: '√n' },
            { id: 'n', label: 'n' },
          ],
        }}
      />,
    );
    screen.getByRole('button', { name: 'n' }).focus();
    await user.keyboard('{Enter}');
    screen.getByRole('button', { name: 'Put n in gap 1' }).focus();
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(result()).toHaveTextContent('Not yet');
    screen.getByRole('button', { name: '√n' }).focus();
    await user.keyboard('{Enter}');
    screen.getByRole('button', { name: 'Put √n in gap 1' }).focus();
    await user.keyboard('{Enter}');
    // The tile it replaced is back among the tiles.
    expect(screen.getByRole('region', { name: 'Tiles' })).toHaveTextContent('n');
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(result()).toHaveTextContent('Correct');
  });

  it('A20 places a point with Enter and moves it with the arrow keys', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        raw={{
          kind: 'plot_points',
          scene: plane,
          points: [{ id: 'a', label: 'A', answer: [2, -1] }],
          snap: 1,
          marks: true,
        }}
      />,
    );
    screen.getByRole('button', { name: 'A' }).focus();
    await user.keyboard('{Enter}');
    const handle = screen.getByRole('slider', { name: 'A' });
    expect(handle).toHaveFocus();
    expect(handle).toHaveAttribute('aria-valuetext', 'A at (0, 0)');
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowDown}');
    expect(handle).toHaveAttribute('aria-valuetext', 'A at (2, -1)');
    expect(screen.getByRole('list', { name: 'Placed points' })).toHaveTextContent('A: (2, -1)');
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(result()).toHaveTextContent('Correct');
  });

  it('A20 shades grid cells with the arrow keys and Space', async () => {
    const user = userEvent.setup();
    render(<Harness raw={{ kind: 'grid', rows: 2, cols: 2, answer: { count: 2 } }} />);
    const first = screen.getByRole('button', { name: 'Row 1, column 1' });
    expect(first).toHaveAttribute('tabindex', '0');
    first.focus();
    await user.keyboard(' ');
    expect(first).toHaveAttribute('aria-pressed', 'true');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'Row 2, column 1' })).toHaveFocus();
    await user.keyboard(' ');
    expect(screen.getByText('2 of 4 cells shaded')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(result()).toHaveTextContent('Correct');
  });

  it('A20 chooses a region of a figure with the arrow keys and Space', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        raw={{
          kind: 'hotspot',
          scene: plane,
          regions: [
            { id: 'a', label: 'Left bar', shape: { type: 'rect', at: [-4, 0], size: [2, 2] } },
            { id: 'b', label: 'Right bar', shape: { type: 'rect', at: [2, 0], size: [2, 4] } },
          ],
          correct: ['b'],
        }}
      />,
    );
    screen.getByRole('radio', { name: 'Left bar' }).focus();
    await user.keyboard(' ');
    expect(screen.getByRole('radio', { name: 'Left bar' })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Right bar' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'Right bar' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByText(/Chosen:/)).toHaveTextContent('Chosen: Right bar');
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(result()).toHaveTextContent('Correct');
  });

  it('A20 sketches a graph point by point with the arrow keys', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        raw={{
          kind: 'sketch_graph',
          scene: { x: [0, 2], y: [-1, 5] },
          answer: '1',
          samples: { from: 0, to: 2, count: 3 },
          tolerance: 0.25,
          marks: true,
        }}
      />,
    );
    const first = screen.getByRole('slider', { name: 'Point at x = 0' });
    expect(first).toHaveAttribute('tabindex', '0');
    first.focus();
    // Page Up moves ten steps of 0.1 at a time.
    await user.keyboard('{PageUp}');
    expect(first).toHaveAttribute('aria-valuetext', 'y = 1');
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(result()).toHaveTextContent('Not yet');
    expect(screen.getByRole('slider', { name: 'Point at x = 1' })).toHaveAttribute(
      'aria-valuetext',
      'y = 0, not right yet',
    );
    screen.getByRole('slider', { name: 'Point at x = 0' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('slider', { name: 'Point at x = 1' })).toHaveFocus();
    await user.keyboard('{PageUp}{ArrowRight}{PageUp}');
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(result()).toHaveTextContent('Correct');
  });

  it('A20 reaches a target with a slider and a point moved from the keyboard', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        raw={{
          kind: 'manipulate',
          params: [
            { name: 'k', label: 'Scale', min: 0, max: 3, step: 1, initial: 1 },
            {
              kind: 'point',
              name: 'P',
              label: 'P',
              x: [-4, 4],
              y: [-4, 4],
              step: 1,
              initial: [1, 1],
            },
          ],
          scene: {
            ...plane,
            shapes: [
              {
                type: 'line',
                through: [
                  [0, 0],
                  ['P.x', 'P.y'],
                ],
              },
            ],
          },
          target: ['near(P.y, k * P.x, 0.01)', 'k == 2'],
          feedback: { ...feedback, rules: [{ when: 'k != 2', say: 'Set the scale to 2.' }] },
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(result()).toHaveTextContent('Not yet: Set the scale to 2.');
    // A range input: the browser moves it with the arrow keys, as a change of its value.
    fireEvent.change(screen.getByRole('slider', { name: /^Scale/ }), { target: { value: '2' } });
    expect(screen.getByRole('slider', { name: /^Scale/ })).toHaveAttribute(
      'aria-valuetext',
      'Scale 2',
    );
    screen.getByRole('slider', { name: 'P' }).focus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('slider', { name: 'P' })).toHaveAttribute(
      'aria-valuetext',
      'P at (1, 2)',
    );
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(result()).toHaveTextContent('Correct');
  });

  it('A20 a handle stops at the last place its grid offers, so a check from the edge is accepted', async () => {
    const user = userEvent.setup();
    const P = {
      kind: 'point' as const,
      name: 'P',
      label: 'P',
      x: [0, 10] as [number, number],
      y: [0, 10] as [number, number],
      step: 3,
      initial: [6, 0] as [number, number],
    };
    render(
      <Harness
        raw={{
          kind: 'manipulate',
          params: [P],
          scene: { x: [0, 10], y: [0, 10] },
          target: ['P.x == 9'],
        }}
      />,
    );
    const handle = screen.getByRole('slider', { name: 'P' });
    handle.focus();
    // 6 → 9, then past the edge: 10 is not on the grid of 3 from 0, so P stays at 9.
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(handle).toHaveAttribute('aria-valuetext', 'P at (9, 0)');
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(result()).toHaveTextContent('Correct');
    // A drag past the corner lands on the last grid point too.
    expect(snapParam(P, [10, 10.4])).toEqual([9, 9]);
  });

  it('A20 Play runs a parameter through the values its slider offers, and Pause keeps one', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        raw={{
          kind: 'explore',
          params: [
            {
              name: 'n',
              label: 'Sample size',
              min: 1,
              max: 25,
              step: 1,
              initial: 1,
              animate: { seconds: 0.5 },
            },
          ],
          scene: { ...plane, shapes: [{ type: 'text', at: [0, 4], text: 'n = {n}' }] },
          feedback: { saved: 'Seen.' },
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Play' }));
    const seen = new Set<string>();
    await waitFor(() => {
      seen.add(screen.getByText(/^n = /).textContent ?? '');
      expect(seen.size).toBeGreaterThan(3);
    });
    // Every value drawn is a whole sample size, as the slider offers it.
    for (const text of seen) expect(text).toMatch(/^n = \d+$/);
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    const kept = screen.getByText(/^n = /).textContent;
    expect(kept).toMatch(/^n = \d+$/);
    expect(screen.getByRole('slider', { name: /^Sample size/ })).toHaveAttribute(
      'aria-valuetext',
      `Sample size ${kept?.slice(4)}`,
    );
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(result()).toHaveTextContent('Correct: Seen.');
  });

  it('A20 Play at the end of a range its grid does not reach starts over and stops at the end', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        raw={{
          kind: 'explore',
          params: [
            {
              name: 'k',
              label: 'Count',
              min: 0,
              max: 10,
              step: 3,
              initial: 9,
              animate: { seconds: 0.5, loop: false },
            },
          ],
          scene: { ...plane, shapes: [{ type: 'text', at: [0, 4], text: 'k = {k}' }] },
          feedback: { saved: 'Seen.' },
        }}
      />,
    );
    // The animation's frames come when the test says, at the times it gives.
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.stubGlobal('requestAnimationFrame', (tick: FrameRequestCallback) => {
      frames.set(++id, tick);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (cancelled: number) => frames.delete(cancelled));
    const frameAt = (ms: number) =>
      act(() => {
        const due = [...frames.values()];
        frames.clear();
        for (const tick of due) tick(ms);
      });
    const shown = () => screen.getByText(/^k = /).textContent;
    // 9 is the last value the slider offers: Play runs from the start again.
    expect(shown()).toBe('k = 9');
    await user.click(screen.getByRole('button', { name: 'Play' }));
    const seen: (string | null)[] = [];
    for (const ms of [0, 150, 300, 450]) {
      frameAt(ms);
      seen.push(shown());
    }
    expect(seen).toEqual(['k = 0', 'k = 3', 'k = 6', 'k = 9']);
    // At the end of the range it stops rather than going round again.
    frameAt(500);
    expect(shown()).toBe('k = 9');
    expect(screen.getByRole('button', { name: 'Play' })).toBeVisible();
    // And it asks for no more frames.
    expect(frames.size).toBe(0);
  });

  it('A07 a reopened drawing is undone and redone, and a description alone saves it', async () => {
    const user = userEvent.setup();
    const stroke = {
      tool: 'pen',
      color: '#202124',
      width: 4,
      points: [
        [0.1, 0.1],
        [0.5, 0.5],
      ],
    };
    render(
      <Harness
        raw={{ kind: 'drawing', feedback: { saved: 'Saved for your instructor.' } }}
        response={{ strokes: [stroke, stroke], description: '' }}
      />,
    );
    expect(screen.getByText('2 strokes')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByText('1 stroke')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Redo' }));
    expect(screen.getByText('2 strokes')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByText('0 strokes')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(result()).toHaveTextContent('Draw something or describe your drawing first.');
    await user.type(
      screen.getByRole('textbox', { name: 'Describe your drawing' }),
      'Points falling from top left to bottom right.',
    );
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(result()).toHaveTextContent('Correct: Saved for your instructor.');
  });
});

describe('interactive steps with a pointer', () => {
  it('A08 a token dragged onto a slot moves there; one dropped elsewhere stays put', async () => {
    render(
      <Harness
        raw={{
          kind: 'categorize',
          categories: [
            { id: 'counted', label: 'Counted' },
            { id: 'measured', label: 'Measured' },
          ],
          items: [
            { id: 'goals', label: 'Goals', category: 'counted' },
            { id: 'height', label: 'Height', category: 'measured' },
          ],
        }}
      />,
    );
    const group = screen.getByRole('region', { name: 'Group Counted' });
    const goals = screen.getByRole('button', { name: 'Goals' });
    // jsdom lays nothing out: the slot under the pointer is the one elementFromPoint names.
    let under: Element | null = group;
    document.elementFromPoint = () => under;
    const pointer = (type: string, x: number) =>
      new PointerEvent(type, { bubbles: true, clientX: x, clientY: 0, pointerId: 1 });
    act(() => {
      goals.dispatchEvent(pointer('pointerdown', 0));
      window.dispatchEvent(pointer('pointermove', 40));
    });
    expect(group).toHaveAttribute('data-over', 'true');
    act(() => {
      window.dispatchEvent(pointer('pointerup', 40));
    });
    expect(within(group).getByRole('button', { name: 'Goals' })).toBeVisible();
    under = null;
    const height = screen.getByRole('button', { name: 'Height' });
    act(() => {
      height.dispatchEvent(pointer('pointerdown', 0));
      window.dispatchEvent(pointer('pointermove', 40));
      window.dispatchEvent(pointer('pointerup', 40));
    });
    expect(screen.getByRole('region', { name: 'Unsorted items' })).toHaveTextContent('Height');
    // After a drag, the next press of Enter picks a token at once.
    const user = userEvent.setup();
    screen.getByRole('button', { name: 'Height' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Height' })).toHaveAttribute('aria-pressed', 'true');
  });
});

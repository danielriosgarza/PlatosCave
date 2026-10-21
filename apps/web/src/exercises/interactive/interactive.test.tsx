import '@testing-library/jest-dom/vitest';
import {
  type ExerciseStep,
  exerciseStep,
  exerciseStepView,
  judge,
  parseResponse,
  viewStep,
} from '@parallax/contracts';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { type InteractiveDraft, interactiveDraft, interactiveResponse } from './draft';
import { InteractiveForm } from './InteractiveForm';

afterEach(cleanup);

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
  });
});

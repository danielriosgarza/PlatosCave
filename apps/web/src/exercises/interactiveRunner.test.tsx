import '@testing-library/jest-dom/vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLASS_A,
  makeMe,
  makeTopics,
  renderApp,
  stubApi,
  studentIn,
  T_SAMPLING,
} from '../test/render';
import type { Attempt, ClassRelease } from './attempt';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const RESOURCE = '00000000-0000-4000-8000-0000000000e1';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stepBase = {
  hintCount: 0,
  hasSolution: true,
  status: 'pending' as const,
  help: null,
  checks: 0,
  hints: [] as string[],
  solution: null,
  response: null as unknown,
  feedback: null,
};
const plane = { x: [-5, 5], y: [-5, 5], axes: true, grid: 1, shapes: [] };

/** A plotting step and a drawing step, with the server's part marks and revealed answer. */
function interactiveApi() {
  let attempt: Attempt = {
    id: uuid(901),
    resourceId: RESOURCE,
    resourceRevisionId: uuid(800),
    number: 1,
    seed: 7,
    completion: null,
    completedAt: null,
    credit: null,
    startedAt: '2026-10-01T09:00:00Z',
    steps: [
      {
        ...stepBase,
        id: 'plot',
        kind: 'plot_points',
        title: 'Plot',
        prompt: 'Plot A at (2, 1) and B at (-1, -2).',
        interactive: {
          kind: 'plot_points',
          scene: plane,
          line: false,
          snap: 1,
          points: [
            { id: 'a', label: 'A', start: [0, 0] },
            { id: 'b', label: 'B', start: [0, 0] },
          ],
        },
      },
      {
        ...stepBase,
        id: 'sketch',
        kind: 'drawing',
        title: 'Sketch',
        prompt: 'Draw a scatter plot with a negative correlation.',
        hasSolution: false,
        interactive: { kind: 'drawing', aspect: 1.6 },
      },
    ],
  } as Attempt;
  const calls: { url: string; body: unknown }[] = [];
  const set = (id: string, patch: object) => {
    attempt = {
      ...attempt,
      steps: attempt.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    } as Attempt;
  };
  const release: ClassRelease = {
    release: { id: uuid(601), version: 2, createdAt: '2026-09-01T09:00:00Z' },
    topics: [
      {
        id: uuid(700),
        topicId: T_SAMPLING,
        position: 0,
        title: 'Sampling',
        objective: '',
        prerequisites: [],
        estimatedMinutes: null,
        resources: [
          {
            id: uuid(701),
            resourceId: RESOURCE,
            revisionId: uuid(800),
            type: 'exercise',
            tab: 'exercises',
            position: 0,
            title: 'Plot and draw',
            visibility: 'visible',
            releaseAt: null,
            credit: null,
          },
        ],
      },
    ],
  };
  stubApi((url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === '/api/me')
      return { status: 200, body: makeMe({ classes: [studentIn(CLASS_A, 'A')] }) };
    if (/\/topics$/.test(url)) return { status: 200, body: makeTopics() };
    if (/\/release$/.test(url)) return { status: 200, body: release };
    if (/\/reviews$/.test(url)) {
      return { status: 200, body: { topicId: T_SAMPLING, complete: false, items: [] } };
    }
    calls.push({ url, body });
    if (url.endsWith('/exercise-attempt')) return { status: 200, body: attempt };
    if (url.endsWith('/check')) {
      const at = body.response as Record<string, [number, number]>;
      const parts = {
        a: at.a?.[0] === 2 && at.a?.[1] === 1,
        b: at.b?.[0] === -1 && at.b?.[1] === -2,
      };
      const correct = parts.a && parts.b;
      const feedback = correct ? 'Both points are in place.' : 'Go along x first, then up or down.';
      set('plot', {
        response: at,
        checks: 1,
        feedback,
        parts,
        ...(correct && { status: 'completed', help: 'independent' }),
      });
      return { status: 200, body: { attempt, result: { correct, feedback, parts } } };
    }
    if (url.endsWith('/solution')) {
      // Like the server: Show solution completes a checked step, and reveals its answer.
      set('plot', {
        status: 'completed',
        help: 'solution_shown',
        solution: 'A is at (2, 1); B at (-1, -2).',
        reveal: { a: [2, 1], b: [-1, -2] },
      });
      return { status: 200, body: attempt };
    }
    if (url.endsWith('/complete')) {
      set(body.stepId, {
        status: 'completed',
        help: 'independent',
        response: body.response,
        feedback: 'Saved for your instructor.',
      });
      return { status: 200, body: attempt };
    }
    return { status: 404, body: {} };
  });
  return { calls };
}

const open = () => renderApp(`/classes/${CLASS_A}/topics/${T_SAMPLING}/exercises`);

describe('interactive steps in an attempt', () => {
  it('A08 a wrong plot marks each point, keeps the points, and the marks go once a point moves', async () => {
    const user = userEvent.setup();
    const { calls } = interactiveApi();
    open();
    expect(await screen.findByRole('heading', { name: 'Plot' })).toBeVisible();
    screen.getByRole('slider', { name: 'A' }).focus();
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowUp}');
    await user.click(screen.getByRole('button', { name: 'Check answer' }));
    expect(await screen.findByText('Go along x first, then up or down.')).toBeVisible();
    expect(screen.getByText(/1 of 2 parts are right/)).toBeVisible();
    expect(screen.getByRole('slider', { name: 'A' })).toHaveAttribute(
      'aria-valuetext',
      'A at (2, 1), right',
    );
    expect(screen.getByRole('slider', { name: 'B' })).toHaveAttribute(
      'aria-valuetext',
      'B at (0, 0), not right yet',
    );
    expect(calls.find((c) => c.url.endsWith('/check'))?.body).toEqual({
      stepId: 'plot',
      response: { a: [2, 1], b: [0, 0] },
    });
    // Moving a point makes the draft a new answer: the old marks no longer describe it.
    screen.getByRole('slider', { name: 'B' }).focus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('slider', { name: 'A' })).toHaveAttribute(
      'aria-valuetext',
      'A at (2, 1)',
    );
  });

  it('A23 Show solution moves the points to the answer and completes the step with the solution shown', async () => {
    const user = userEvent.setup();
    interactiveApi();
    open();
    await screen.findByRole('heading', { name: 'Plot' });
    await user.click(screen.getByRole('button', { name: 'Show solution' }));
    expect(await screen.findByText('A is at (2, 1); B at (-1, -2).')).toBeVisible();
    // The points travel to the answer over a moment; the handle is found by its place in the
    // drawing, since role queries over the whole page are slow while it animates.
    await waitFor(
      () =>
        expect(document.querySelector('[data-handle="b"]')).toHaveAttribute(
          'aria-valuetext',
          'B at (-1, -2)',
        ),
      { timeout: 3000 },
    );
    expect(
      screen.getByText('This step is recorded as completed with the solution shown.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Check answer' })).toBeNull();
  }, 15_000);

  it('A07 a drawing is saved with its description through Save drawing', async () => {
    const user = userEvent.setup();
    const { calls } = interactiveApi();
    open();
    await screen.findByRole('heading', { name: 'Plot' });
    // Reach the drawing: the plot is answered first.
    screen.getByRole('slider', { name: 'A' }).focus();
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowUp}');
    screen.getByRole('slider', { name: 'B' }).focus();
    await user.keyboard('{ArrowLeft}{ArrowDown}{ArrowDown}');
    await user.click(screen.getByRole('button', { name: 'Check answer' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Sketch' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save drawing' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Draw something or describe your drawing first.',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Describe your drawing' }),
      'Points falling to the right.',
    );
    await user.click(screen.getByRole('button', { name: 'Save drawing' }));
    const feedback = await screen.findByText('Saved for your instructor.');
    expect(within(feedback.parentElement as HTMLElement).getByText('Saved.')).toBeVisible();
    expect(calls.find((c) => c.url.endsWith('/complete'))?.body).toEqual({
      stepId: 'sketch',
      response: { strokes: [], description: 'Points falling to the right.' },
    });
  });
});

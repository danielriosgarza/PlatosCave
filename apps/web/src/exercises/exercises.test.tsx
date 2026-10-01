import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLASS_A,
  instructorIn,
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

function freshAttempt(number: number): Attempt {
  return {
    id: uuid(900 + number),
    resourceId: RESOURCE,
    resourceRevisionId: uuid(800),
    number,
    seed: 7,
    completion: null,
    completedAt: null,
    startedAt: '2026-10-01T09:00:00Z',
    steps: [
      {
        ...stepBase,
        id: 'predict',
        kind: 'single_choice',
        title: 'Predict',
        prompt: 'What happens to the spread of sample means when n grows from 25 to 100?',
        hintCount: 2,
        options: [
          { id: 'wider', label: 'Wider' },
          { id: 'same', label: 'About the same' },
          { id: 'narrower', label: 'Narrower' },
        ],
      },
      {
        ...stepBase,
        id: 'inspect',
        kind: 'simulation',
        title: 'Inspect',
        prompt: 'Compare n = 100 with the baseline n = 25.',
        control: { name: 'n', label: 'Sample size', min: 25, max: 200, step: 25, initial: 25 },
        observations: [],
        compare: [25, 100],
        compared: [],
      },
      {
        ...stepBase,
        id: 'explain',
        kind: 'text',
        title: 'Explain',
        prompt: 'Explain the result in your own words.',
        maxLength: 4000,
      },
    ],
  };
}

/** A stand-in for the exercise routes with the behaviour the UI relies on (the real ones run in e2e). */
function exerciseApi(options: { releaseAt?: string | null; role?: 'student' | 'instructor' } = {}) {
  let attempt = freshAttempt(1);
  const calls: { url: string; body: unknown }[] = [];
  const step = (id: string) => attempt.steps.find((s) => s.id === id);
  const set = (id: string, patch: object) => {
    attempt = {
      ...attempt,
      steps: attempt.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    } as Attempt;
  };
  const finish = () => {
    if (attempt.steps.every((s) => s.help)) {
      const helps = attempt.steps.map((s) => s.help);
      attempt = {
        ...attempt,
        completion: helps.includes('solution_shown')
          ? 'solution_shown'
          : helps.includes('with_hints')
            ? 'with_hints'
            : 'independent',
        completedAt: '2026-10-01T09:05:00Z',
      };
    }
  };
  const helpOf = (id: string) => {
    const s = step(id);
    return s?.solution ? 'solution_shown' : s && s.hints.length > 0 ? 'with_hints' : 'independent';
  };
  const me = makeMe({
    classes: [
      options.role === 'instructor'
        ? instructorIn(CLASS_A, 'Autumn 2026 A')
        : studentIn(CLASS_A, 'Autumn 2026 A'),
    ],
  });
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
            title: 'Sample size and spread',
            visibility: 'visible',
            releaseAt: options.releaseAt ?? null,
          },
        ],
      },
    ],
  };
  const stub = stubApi((url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === '/api/me') return { status: 200, body: me };
    if (/\/topics$/.test(url)) return { status: 200, body: makeTopics() };
    if (/\/release$/.test(url)) return { status: 200, body: release };
    calls.push({ url, body });
    if (url.endsWith('/exercise-attempt')) return { status: 200, body: attempt };
    if (url.endsWith('/check')) {
      const id = body.stepId as string;
      if (id === 'predict') {
        if (body.response === 'narrower') {
          set(id, {
            status: 'completed',
            help: helpOf(id),
            response: 'narrower',
            checks: 1,
            feedback: 'Yes: the spread narrows.',
          });
          return { status: 200, body: { attempt, result: { correct: true, feedback: 'Yes' } } };
        }
        const feedback = 'Larger samples average out more noise.';
        set(id, { response: body.response, checks: 1, feedback });
        return { status: 200, body: { attempt, result: { correct: false, feedback } } };
      }
      const compared = [...new Set([...(step(id)?.compared ?? []), body.response.value])];
      const done = [25, 100].every((v) => compared.includes(v));
      set(id, {
        compared,
        response: body.response,
        feedback: done ? 'Both compared.' : 'Now compare with n = 100.',
        ...(done && { status: 'completed', help: helpOf(id) }),
      });
      return { status: 200, body: { attempt, result: { correct: done, feedback: '' } } };
    }
    if (url.endsWith('/hint')) {
      const s = step(body.stepId);
      const all = ['Think about averaging.', 'SE is σ/√n.'];
      set(body.stepId, { hints: all.slice(0, (s?.hints.length ?? 0) + 1) });
      return { status: 200, body: attempt };
    }
    if (url.endsWith('/solution')) {
      set(body.stepId, {
        status: 'completed',
        help: 'solution_shown',
        solution: 'Narrower: quadrupling n halves the SE.',
      });
      return { status: 200, body: attempt };
    }
    if (url.endsWith('/complete')) {
      set(body.stepId, {
        status: 'completed',
        help: helpOf(body.stepId),
        response: body.response,
        feedback: 'Saved. Your practice is complete.',
      });
      finish();
      return { status: 200, body: attempt };
    }
    if (url.endsWith('/restart')) {
      attempt = freshAttempt(attempt.number + 1);
      return { status: 200, body: attempt };
    }
    return { status: 404, body: {} };
  });
  return { stub, calls };
}

const open = () => renderApp(`/classes/${CLASS_A}/topics/${T_SAMPLING}/exercises`);
const posted = <T extends { url: string }>(calls: T[], suffix: string) =>
  calls.filter((c) => c.url.endsWith(suffix));

describe('exercise UI', () => {
  it('A08 a wrong answer shows specific feedback, keeps the choice and allows another check', async () => {
    const user = userEvent.setup();
    const { calls } = exerciseApi();
    open();
    expect(await screen.findByRole('heading', { name: 'Predict' })).toBeVisible();
    expect(screen.getByRole('list', { name: /Exercise step 1 of 3: Predict/ })).toBeVisible();

    await user.click(screen.getByRole('radio', { name: 'Wider' }));
    await user.click(screen.getByRole('button', { name: 'Check answer' }));
    expect(await screen.findByText('Larger samples average out more noise.')).toBeVisible();
    expect(screen.getByText('Not yet.')).toBeVisible();
    // The work is kept and the step is still open for a retry.
    expect(screen.getByRole('radio', { name: 'Wider' })).toBeChecked();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();

    await user.click(screen.getByRole('radio', { name: 'Narrower' }));
    await user.click(screen.getByRole('button', { name: 'Check answer' }));
    expect(await screen.findByText('Correct.')).toBeVisible();
    expect(posted(calls, '/check')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Inspect' })).toBeVisible();
  });

  it('A08 checking with nothing chosen asks for an answer and records nothing', async () => {
    const user = userEvent.setup();
    const { calls } = exerciseApi();
    open();
    await user.click(await screen.findByRole('button', { name: 'Check answer' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose an answer before checking it.');
    expect(posted(calls, '/check')).toHaveLength(0);
  });

  it('A23 hiding a hint keeps the recorded use visible, and Show solution is its own step event', async () => {
    const user = userEvent.setup();
    const { calls } = exerciseApi();
    open();
    await user.click(await screen.findByRole('button', { name: 'Show a hint' }));
    expect(await screen.findByText(/Think about averaging/)).toBeVisible();
    expect(screen.getByText(/Hints used: 1 of 2/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Hide hints' }));
    expect(screen.queryByText(/Think about averaging/)).toBeNull();
    expect(screen.getByText(/Hints used: 1 of 2/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show hints' }));
    expect(screen.getByText(/Think about averaging/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Show solution' }));
    expect(await screen.findByText(/Narrower: quadrupling n halves the SE/)).toBeVisible();
    expect(screen.getByText(/completed with the solution shown/)).toBeVisible();
    expect(posted(calls, '/hint')).toHaveLength(1);
    expect(posted(calls, '/solution')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeVisible();
  });

  it('A23 the simulation control moves with buttons and records only the chosen values', async () => {
    const user = userEvent.setup();
    const { calls } = exerciseApi();
    open();
    await user.click(await screen.findByRole('radio', { name: 'Narrower' }));
    await user.click(screen.getByRole('button', { name: 'Check answer' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));

    const slider = await screen.findByRole('slider', { name: /Sample size/ });
    expect(slider).toHaveValue('25');
    await user.click(screen.getByRole('button', { name: 'Record this value' }));
    expect(await screen.findByText('Now compare with n = 100.')).toBeVisible();
    const readout = screen.getByRole('list', { name: 'Values recorded for comparison' });
    expect(within(readout).getByText(/n = 25 · recorded/)).toBeVisible();
    expect(within(readout).getByText(/n = 100 · not yet recorded/)).toBeVisible();

    // Three increases of one step each reach 100; the slider is the keyboard-operable range.
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole('button', { name: 'Increase' }));
    expect(slider).toHaveValue('100');
    fireEvent.change(slider, { target: { value: '100' } });
    await user.click(screen.getByRole('button', { name: 'Record this value' }));
    expect(await screen.findByText('Correct.')).toBeVisible();
    expect(posted(calls, '/check').at(-1)?.body).toEqual({
      stepId: 'inspect',
      response: { value: 100, observations: {} },
    });
  });

  it('A23 an empty explanation cannot complete the final step', async () => {
    const user = userEvent.setup();
    const { calls } = exerciseApi();
    open();
    await user.click(await screen.findByRole('button', { name: 'Show solution' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Record this value' }));
    await user.click(await screen.findByRole('button', { name: 'Show solution' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Explain' })).toBeVisible();
    await user.type(screen.getByLabelText('Your explanation'), '   ');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Write your explanation first.');
    expect(posted(calls, '/complete')).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: 'Exercise complete.' })).toBeNull();
  });

  it('A23 completing records how each step was done, and Start again opens a new attempt', async () => {
    const user = userEvent.setup();
    const { calls } = exerciseApi();
    open();
    await user.click(await screen.findByRole('button', { name: 'Show a hint' }));
    await user.click(await screen.findByRole('radio', { name: 'Narrower' }));
    await user.click(screen.getByRole('button', { name: 'Check answer' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Show solution' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText('Your explanation'), 'Averages vary less.');
    await user.click(screen.getByRole('button', { name: 'Done' }));

    expect(await screen.findByRole('heading', { name: 'Exercise complete.' })).toBeVisible();
    expect(screen.getByText(/Completed with the solution shown\./)).toBeVisible();
    expect(screen.getByText(/practice is ungraded/)).toBeVisible();
    const how = screen.getByRole('list', { name: 'How each step was completed' });
    expect(within(how).getByText('Predict').parentElement).toHaveTextContent('with hints');
    expect(within(how).getByText('Inspect').parentElement).toHaveTextContent(
      'with the solution shown',
    );
    expect(within(how).getByText('Explain').parentElement).toHaveTextContent('independently');

    await user.click(screen.getByRole('button', { name: 'Start again' }));
    expect(await screen.findByRole('heading', { name: 'Predict' })).toBeVisible();
    expect(posted(calls, '/restart')).toHaveLength(1);
    expect(screen.getByRole('radio', { name: 'Narrower' })).not.toBeChecked();
  });

  it('a scheduled exercise is locked for a student with its release date, and is not opened', async () => {
    const { calls } = exerciseApi({ releaseAt: '2099-01-15T09:00:00Z' });
    open();
    const list = await screen.findByRole('list', { name: 'Exercises in this topic' });
    expect(within(list).getByText('Sample size and spread')).toBeVisible();
    expect(within(list).getByText(/Opens 15 Jan 2099/)).toBeVisible();
    expect(within(list).queryByRole('button', { name: 'Start' })).toBeNull();
    await waitFor(() => expect(screen.getByText('Locked')).toBeVisible());
    expect(posted(calls, '/exercise-attempt')).toHaveLength(0);
  });

  it('an instructor can open a scheduled exercise to prepare it', async () => {
    exerciseApi({ releaseAt: '2099-01-15T09:00:00Z', role: 'instructor' });
    open();
    expect(await screen.findByRole('heading', { name: 'Predict' })).toBeVisible();
  });

  it('an action that cannot reach the server says so and keeps the work', async () => {
    const user = userEvent.setup();
    const { stub } = exerciseApi();
    open();
    await user.click(await screen.findByRole('radio', { name: 'Wider' }));
    const fetchMock = stub;
    const original = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/check')) return new Response('oops', { status: 500 });
      return original ? original(input, init) : new Response(null, { status: 500 });
    });
    await user.click(screen.getByRole('button', { name: 'Check answer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be recorded');
    expect(screen.getByRole('radio', { name: 'Wider' })).toBeChecked();
    expect(screen.queryByText('Correct.')).toBeNull();
  });
});

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COURSE, makeMe, renderApp, stubApi } from './render';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TOPIC = '00000000-0000-4000-8000-0000000000a1';
const EXERCISE = '00000000-0000-4000-8000-0000000000e1';
const REVISION = '00000000-0000-4000-8000-0000000000c1';
const stamp = '2026-10-01T09:00:00.000Z';

const summary = {
  id: EXERCISE,
  courseId: COURSE,
  topicId: TOPIC,
  type: 'exercise',
  title: 'Sample size',
  position: 0,
  visibility: 'visible',
  releaseAt: null,
  headRevisionId: REVISION,
  revision: 1,
  archived: false,
  updatedAt: stamp,
};

const content = {
  schema: 'exercise.v1',
  steps: [
    {
      id: 'inspect',
      kind: 'simulation',
      title: 'Inspect',
      prompt: 'Compare n = 100 with n = 25.',
      hints: [],
      control: { name: 'n', label: 'Sample size', min: 5, max: 200, step: 5, initial: 25 },
      observations: [],
      compare: [25, 100],
      feedback: { correct: 'Both compared.', incomplete: 'Compare with 100.' },
    },
  ],
};

const full = {
  ...summary,
  head: {
    id: REVISION,
    content,
    objectKeys: [],
    accessibleAlternative: null,
    provenance: null,
    contentHash: 'h',
    createdBy: COURSE,
    createdAt: stamp,
  },
};

const json = (body: unknown, status = 200) => ({ status, body });

function open(stored: unknown = content) {
  let current = { ...full, head: { ...full.head, content: stored } };
  const patched: Record<string, unknown>[] = [];
  const me = makeMe({
    courses: [
      {
        courseId: COURSE,
        title: 'Statistical thinking',
        owner: false,
        editor: true,
        publisher: true,
      },
    ],
  });
  stubApi((url, init) => {
    const path = url.split('?')[0] ?? url;
    const base = `/api/courses/${COURSE}`;
    if (path === '/api/me') return json(me);
    if (path === `${base}/drafts`) {
      return json({
        topics: [
          {
            id: TOPIC,
            courseId: COURSE,
            position: 0,
            title: 'Sampling',
            objective: 'Explain why estimates differ.',
            prerequisites: [],
            completionRule: null,
            estimatedMinutes: 45,
            revision: 1,
            archived: false,
            updatedAt: stamp,
            resources: [summary],
          },
        ],
      });
    }
    if (path === `${base}/overview`) {
      return json({ id: COURSE, title: 'Statistical thinking', latestRelease: null, classes: [] });
    }
    if (path === `${base}/processing`) return json({ resources: [] });
    if (path === `${base}/releases/validation`) return json({ errors: [], warnings: [] });
    if (path === `${base}/resources/${EXERCISE}` && (init?.method ?? 'GET') === 'GET') {
      return json(current);
    }
    if (path === `${base}/resources/${EXERCISE}` && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body));
      patched.push(body);
      current = {
        ...current,
        revision: 1 + patched.length,
        head: body.content ? { ...current.head, content: body.content } : current.head,
      };
      return json(current);
    }
    return json({ error: 'not found' }, 404);
  });
  renderApp(`/courses/${COURSE}/edit/${TOPIC}`);
  return patched;
}

const editor = async (stored: unknown = content) => {
  const user = userEvent.setup();
  const patched = open(stored);
  await user.click(await screen.findByRole('button', { name: 'Edit Sample size' }));
  await screen.findByLabelText('Exercise title');
  return { user, patched };
};

describe('exercise editor', () => {
  it('shows the stored steps in a form and saves a valid edit as new content', async () => {
    const { user, patched } = await editor();
    const prompt = screen.getByLabelText('Step 1 prompt');
    expect(prompt).toHaveValue('Compare n = 100 with n = 25.');
    await user.clear(prompt);
    await user.type(prompt, 'Compare n = 200 with n = 25.');
    await waitFor(() => expect(patched).toHaveLength(1), { timeout: 3000 });
    expect(patched[0]).toMatchObject({
      expectedRevision: 1,
      content: {
        schema: 'exercise.v1',
        steps: [{ id: 'inspect', prompt: 'Compare n = 200 with n = 25.' }],
      },
    });
    expect(await screen.findByText(/Draft saved at/)).toBeInTheDocument();
  });

  it('lists what is wrong and sends no steps, saying the last saved version stays current', async () => {
    const { user, patched } = await editor();
    const compare = screen.getByLabelText(/Step 1 values to compare/);
    await user.clear(compare);
    await user.type(compare, '25, 102');
    const problems = await screen.findByRole('status', { name: 'Exercise problems' });
    expect(
      within(problems).getByText(/Step 1 “Inspect”: compare values must be/),
    ).toBeInTheDocument();
    expect(
      within(problems).getByText(/not saved yet; publishing would release the last saved version/),
    ).toBeInTheDocument();
    await waitFor(() => expect(patched).toHaveLength(1), { timeout: 3000 });
    expect(patched[0]).not.toHaveProperty('content');
    // Only the title and visibility were acknowledged, and the status says so.
    expect(
      await screen.findByText(
        'Title, visibility and archive state saved; step and credit edits are not saved yet',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Draft saved at/)).not.toBeInTheDocument();
  });

  it('says publishing is blocked only while the stored head is invalid, not after a valid save', async () => {
    const invalid = {
      ...content,
      steps: [{ ...content.steps[0], compare: [25, 102] }],
    };
    const { user, patched } = await editor(invalid);
    const problems = await screen.findByRole('status', { name: 'Exercise problems' });
    expect(
      within(problems).getByText(/Publishing is blocked until a valid definition is saved/),
    ).toBeInTheDocument();
    // The invalid head loads as a blank form; filling it in saves a valid definition.
    for (const [label, text] of [
      ['Step 1 title', 'Pick'],
      ['Step 1 prompt', 'Which is wider?'],
      ['Step 1 option 1', 'Small'],
      ['Step 1 option 2', 'Large'],
      ['Step 1 feedback when correct', 'Yes.'],
      ['Step 1 feedback when incorrect', 'No.'],
    ] as const) {
      await user.type(screen.getByLabelText(label), text);
    }
    await waitFor(() => expect(patched.at(-1)).toHaveProperty('content'), { timeout: 3000 });
    const title = screen.getByLabelText('Step 1 title');
    await user.clear(title);
    const again = await screen.findByRole('status', { name: 'Exercise problems' });
    expect(
      within(again).getByText(/publishing would release the last saved version/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Publishing is blocked/)).not.toBeInTheDocument();
  });

  it('still saves title and archive while the steps are invalid', async () => {
    const { user, patched } = await editor();
    const compare = screen.getByLabelText(/Step 1 values to compare/);
    await user.clear(compare);
    await user.type(compare, '25, 102');
    await user.click(screen.getByRole('button', { name: 'Archive this exercise' }));
    await waitFor(() => expect(patched.at(-1)).toMatchObject({ archived: true }), {
      timeout: 3000,
    });
    expect(patched.at(-1)).not.toHaveProperty('content');
  });

  it('adds a step, which keeps the exercise unpublishable until it is filled in', async () => {
    const { user } = await editor();
    await user.selectOptions(screen.getByLabelText(/Step type/), 'numeric');
    await user.click(screen.getByRole('button', { name: 'Add step' }));
    expect(screen.getByRole('group', { name: 'Step 2' })).toBeInTheDocument();
    expect(await screen.findByText(/Step 2 · prompt/)).toBeInTheDocument();
  });

  it('sets points and a hint policy for credit, or leaves the exercise as practice', async () => {
    const { user, patched } = await editor();
    expect(
      screen.getByText('Students see this exercise as ungraded practice.'),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Points/), '12');
    await user.selectOptions(screen.getByLabelText('Hint policy'), 'forfeits_credit');
    await waitFor(() => expect(patched.length).toBeGreaterThan(0), { timeout: 3000 });
    expect(patched.at(-1)).toMatchObject({
      content: { credit: { points: 12, hintPolicy: 'forfeits_credit' } },
    });
  });
});

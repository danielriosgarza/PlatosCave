import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
      return json({
        id: COURSE,
        title: 'Statistical thinking',
        archived: false,
        latestRelease: null,
        classes: [],
      });
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
    expect(await screen.findByText(/^Saved$/)).toBeInTheDocument();
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
    // Title and visibility already match the stored copy, so no request is made, and the status
    // says the steps are not saved.
    expect(
      await screen.findByText(
        'Title, visibility and archive state saved; step and credit edits are not saved yet',
        undefined,
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();
    expect(patched).toHaveLength(0);
    expect(screen.queryByText(/^Saved$/)).not.toBeInTheDocument();
  });

  it('sends nothing more while only the steps change and they stay invalid', async () => {
    const { user, patched } = await editor();
    const compare = screen.getByLabelText(/Step 1 values to compare/);
    await user.clear(compare);
    await user.type(compare, '25, 102');
    // Title and visibility are unchanged from the stored copy, so nothing is worth sending.
    await screen.findByText(
      'Title, visibility and archive state saved; step and credit edits are not saved yet',
      undefined,
      { timeout: 3000 },
    );
    await user.type(compare, '0');
    await new Promise((r) => setTimeout(r, 1200));
    expect(patched).toHaveLength(0);
    // A title edit is still sent, without the withheld steps.
    await user.type(screen.getByLabelText('Exercise title'), '!');
    await waitFor(() => expect(patched).toHaveLength(1), { timeout: 3000 });
    expect(patched[0]).not.toHaveProperty('content');
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

  it('A42 adds an interactive step as YAML fields, previews it, and tries it as a student would', async () => {
    const { user } = await editor();
    await user.selectOptions(screen.getByLabelText(/Step type/), 'hotspot');
    await user.click(screen.getByRole('button', { name: 'Add step' }));
    const step = screen.getByRole('group', { name: 'Step 2' });
    const fields = within(step).getByRole('textbox', { name: 'Step 2 fields (YAML)' });
    expect((fields as HTMLTextAreaElement).value).toContain('correct: [b3]');
    const preview = within(step).getByRole('region', { name: 'Preview of step 2' });
    within(preview).getByRole('radio', { name: 'First bar' }).focus();
    await user.keyboard(' ');
    await user.click(within(preview).getByRole('button', { name: 'Try checking' }));
    expect(within(preview).getByRole('status')).toHaveTextContent(
      'Not yet.The mode is the class with the most values.',
    );
    await user.click(within(preview).getByRole('button', { name: 'Show the expected answer' }));
    await waitFor(() =>
      expect(within(preview).getByRole('radio', { name: 'Third bar' })).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    );
    await user.click(within(preview).getByRole('button', { name: 'Try checking' }));
    expect(within(preview).getByRole('status')).toHaveTextContent('Correct.');
    // A field the schema refuses is listed with its step and path, and the preview waits for it.
    await user.clear(fields);
    await user.click(fields);
    await user.paste('scene: { x: [0, 1], y: [0, 1] }\nregions: []\ncorrect: [a]\n');
    expect(within(step).queryByRole('region', { name: 'Preview of step 2' })).toBeNull();
    expect(screen.getByRole('status', { name: 'Exercise problems' })).toHaveTextContent(
      /Step 2 .* regions: needs at least 2/,
    );
  });

  it('A42 finds an icon by what it shows and puts its name in place of the selection in the fields', async () => {
    const { user } = await editor();
    await user.selectOptions(screen.getByLabelText(/Step type/), 'hotspot');
    await user.click(screen.getByRole('button', { name: 'Add step' }));
    const step = screen.getByRole('group', { name: 'Step 2' });
    const fields = within(step).getByRole('textbox', {
      name: 'Step 2 fields (YAML)',
    }) as HTMLTextAreaElement;
    await user.clear(fields);
    await user.click(fields);
    await user.paste(
      'scene: { x: [0, 4], y: [0, 2] }\nregions:\n' +
        '  - { id: a, label: A, shape: { type: icon, name: ICON, at: [1, 1] } }\n' +
        '  - { id: b, label: B, shape: { type: icon, name: circle, at: [3, 1] } }\n' +
        'correct: [a]\nfeedback: { correct: Yes., incorrect: Not yet. }\n',
    );
    const at = fields.value.indexOf('ICON');
    fields.setSelectionRange(at, at + 'ICON'.length);
    fireEvent.select(fields);
    await user.click(within(step).getByRole('button', { name: 'Find an icon' }));
    await user.type(within(step).getByRole('searchbox', { name: 'Icon' }), 'pine');
    const found = await within(step).findByRole(
      'list',
      { name: 'Matching icons' },
      { timeout: 5000 },
    );
    // Named by its words first: tree-pine is a pine; others only list it among their search words.
    expect(within(found).getAllByRole('button')[0]).toHaveAccessibleName('tree-pine');
    await user.click(within(found).getByRole('button', { name: 'tree-pine' }));
    expect(fields.value).toContain('name: tree-pine, at: [1, 1]');
    expect(fields).toHaveFocus();
    expect(fields.selectionStart).toBe(at + 'tree-pine'.length);
    // A search with no match says so; one found by a search word lists the icons it names.
    await user.clear(within(step).getByRole('searchbox', { name: 'Icon' }));
    await user.type(within(step).getByRole('searchbox', { name: 'Icon' }), 'xyzzy');
    expect(within(step).getByText('No icon matches. Try another word.')).toBeInTheDocument();
    await user.clear(within(step).getByRole('searchbox', { name: 'Icon' }));
    await user.type(within(step).getByRole('searchbox', { name: 'Icon' }), 'fruit');
    expect(
      within(within(step).getByRole('list', { name: 'Matching icons' })).getByRole('button', {
        name: 'banana',
      }),
    ).toBeInTheDocument();
    const preview = within(step).getByRole('region', { name: 'Preview of step 2' });
    expect(within(preview).getByRole('radio', { name: 'A' })).toBeInTheDocument();
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

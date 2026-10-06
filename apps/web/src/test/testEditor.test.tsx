import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestEditor } from '../authoring/TestEditor';
import { createQueryClient } from '../session/revocation';
import { COURSE, stubApi } from './render';

/** The test editor (P3-18): autosave of valid content only, publication findings, preview runs. */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const RESOURCE = '00000000-0000-4000-8000-0000000000b1';
const REVISION = '00000000-0000-4000-8000-0000000000c1';
const RUN = '00000000-0000-4000-8000-0000000000d1';
const stamp = '2026-10-01T09:00:00.000Z';
const base = `/api/courses/${COURSE}`;

const content = {
  questions: [
    {
      id: 'mean',
      kind: 'code',
      prompt: 'Write mean(xs).',
      points: 4,
      runtime: 'python-3.12',
      files: [
        {
          path: 'solution.py',
          content: 'def mean(xs):\n    pass\n',
          editable: true,
          hidden: false,
        },
      ],
      allowedPackages: ['numpy'],
      checks: [
        {
          name: 'sample',
          kind: 'call',
          visibility: 'public',
          file: 'solution.py',
          function: 'mean',
          args: [[1, 2, 3]],
          expected: { value: 2 },
          compare: { mode: 'numeric' },
          points: 1,
        },
        {
          name: 'hidden-large',
          kind: 'call',
          visibility: 'hidden',
          file: 'solution.py',
          function: 'mean',
          args: [[40, 44]],
          expected: { value: 42 },
          compare: { mode: 'numeric' },
          points: 3,
        },
      ],
    },
  ],
};

const resource = (over: Record<string, unknown> = {}) => ({
  id: RESOURCE,
  courseId: COURSE,
  topicId: '00000000-0000-4000-8000-0000000000a1',
  type: 'test',
  title: 'Spread check',
  position: 0,
  visibility: 'visible',
  releaseAt: null,
  headRevisionId: REVISION,
  revision: 1,
  archived: false,
  updatedAt: stamp,
  head: {
    id: REVISION,
    content,
    objectKeys: [],
    accessibleAlternative: null,
    provenance: null,
    contentHash: 'h',
    createdBy: '00000000-0000-4000-8000-000000000001',
    createdAt: stamp,
  },
  ...over,
});

const run = (over: Record<string, unknown> = {}) => ({
  runId: RUN,
  state: 'passed',
  questionId: 'mean',
  questionRevisionId: REVISION,
  reason: 'preview',
  checkSet: 'full',
  codeHash: 'x',
  graderVersion: 'g',
  runtimeId: 'python-3.12',
  imageRef: 'img',
  queuedAt: stamp,
  startedAt: stamp,
  finishedAt: stamp,
  infrastructureAttempts: 0,
  failure: null,
  requestedBy: null,
  note: null,
  supersededBy: null,
  result: {
    status: 'passed',
    imageId: 'sha256:1',
    imageDigest: null,
    harnessVersion: '1',
    outcome: {
      v: 1,
      jobId: RUN,
      status: 'passed',
      image: { ref: 'img', id: 'sha256:1', digest: null },
      container: { exitCode: 0, oomKilled: false, killedByTimer: false, durationMs: 9 },
      result: {
        v: 1,
        harnessVersion: '1',
        runtime: { language: 'python', version: '3.12.8' },
        checks: [
          {
            name: 'sample',
            status: 'passed',
            durationMs: 3,
            stdout: '',
            stderr: '',
            truncated: false,
          },
          {
            name: 'hidden-large',
            status: 'failed',
            durationMs: 3,
            expected: '42',
            actual: '40',
            stdout: '',
            stderr: '',
            truncated: false,
          },
        ],
        truncated: false,
        durationMs: 9,
      },
      harnessLog: '',
    },
  },
  ...over,
});

interface Server {
  report: { errors: object[]; warnings: object[] };
  patched: Record<string, unknown>[];
  posted: { url: string; body: Record<string, unknown> }[];
  previewStatus: number;
  previewError: Record<string, unknown>;
  readStatus: number;
  reads: number;
  current: ReturnType<typeof resource>;
}

function serve(over: Partial<Server> = {}): Server {
  const s: Server = {
    report: { errors: [], warnings: [] },
    patched: [],
    posted: [],
    previewStatus: 202,
    previewError: { error: 'no_class', message: 'no class' },
    readStatus: 200,
    reads: 0,
    current: resource(),
    ...over,
  };
  stubApi((url, init) => {
    const method = init?.method ?? 'GET';
    if (url === `${base}/resources/${RESOURCE}` && method === 'GET') {
      return { status: 200, body: s.current };
    }
    if (url === `${base}/resources/${RESOURCE}` && method === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      s.patched.push(body);
      return { status: 200, body: { ...s.current, revision: 2 } };
    }
    if (url === `${base}/runtimes`) {
      return {
        status: 200,
        body: {
          runtimes: [{ id: 'python-3.12', language: 'python', packages: ['numpy', 'pandas'] }],
        },
      };
    }
    if (url === `${base}/releases/validation`) return { status: 200, body: s.report };
    if (url.endsWith('/preview-runs') && method === 'POST') {
      s.posted.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return s.previewStatus === 202
        ? { status: 202, body: run({ state: 'queued', result: null, finishedAt: null }) }
        : { status: s.previewStatus, body: s.previewError };
    }
    if (url === `${base}/preview-runs/${RUN}`) {
      s.reads += 1;
      return s.readStatus === 200
        ? { status: 200, body: run() }
        : { status: s.readStatus, body: { error: 'internal' } };
    }
    return { status: 404, body: {} };
  });
  return s;
}

function mount() {
  const queryClient = createQueryClient({ retry: false });
  render(
    <QueryClientProvider client={queryClient}>
      <TestEditor courseId={COURSE} resourceId={RESOURCE} onSaved={() => undefined} />
    </QueryClientProvider>,
  );
}

describe('test editor', () => {
  it('shows the saved questions, runtime, files, packages and checks', async () => {
    serve();
    mount();
    expect(await screen.findByLabelText('Question 1 prompt and input/output contract')).toHaveValue(
      'Write mean(xs).',
    );
    expect(await screen.findByLabelText('Language and version')).toHaveValue('python-3.12');
    expect(screen.getByLabelText('File 1 path')).toHaveValue('solution.py');
    expect(screen.getByLabelText('numpy')).toBeChecked();
    expect(screen.getByLabelText('pandas')).not.toBeChecked();
    expect(screen.getByLabelText('Check 1 visibility')).toHaveValue('public');
    expect(screen.getByLabelText('Check 2 visibility')).toHaveValue('hidden');
    expect(screen.getByLabelText('Check 2 expected value (JSON)')).toHaveValue('42');
  });

  it('saves valid content after an edit, with the revision the editor last saw', async () => {
    const s = serve();
    mount();
    const prompt = await screen.findByLabelText('Question 1 prompt and input/output contract');
    await userEvent.type(prompt, ' Return a float.');
    await waitFor(() => expect(s.patched).toHaveLength(1), { timeout: 3000 });
    expect(s.patched[0]).toMatchObject({ expectedRevision: 1 });
    const saved = s.patched[0]?.content as typeof content & { settings: { attempts: number } };
    expect(saved.questions[0]?.prompt).toBe('Write mean(xs). Return a float.');
    expect(saved.settings.attempts).toBe(1);
    expect(await screen.findByText(/Draft saved at/)).toBeInTheDocument();
  });

  it('keeps invalid edits out of the revision and says what is wrong', async () => {
    const s = serve();
    mount();
    const args = await screen.findByLabelText('Check 1 arguments (JSON array)');
    await userEvent.clear(args);
    await userEvent.click(args);
    await userEvent.paste('not json');
    expect(
      await screen.findByText('Question 1, check 1: arguments must be valid JSON'),
    ).toBeInTheDocument();
    // Nothing the server would store changed, so no request moves the revision.
    expect(
      await screen.findByText(/question and setting edits are not saved yet/),
    ).toBeInTheDocument();
    expect(s.patched).toHaveLength(0);
    // A title edit is still saved, without the questions.
    await userEvent.type(screen.getByLabelText('Test title'), ' 2');
    await waitFor(() => expect(s.patched).toHaveLength(1), { timeout: 3000 });
    expect(s.patched[0]).toMatchObject({ title: 'Spread check 2' });
    expect(s.patched[0]).not.toHaveProperty('content');
  });

  it('gives a new rubric criterion an unused id', async () => {
    serve();
    mount();
    const add = await screen.findByRole('button', { name: 'Add criterion' });
    await userEvent.click(add);
    await userEvent.click(add);
    await userEvent.click(screen.getByRole('button', { name: 'Remove criterion 1' }));
    await userEvent.click(add);
    expect(screen.getByLabelText('Criterion 1 id')).toHaveValue('c2');
    expect(screen.getByLabelText('Criterion 2 id')).toHaveValue('c3');
  });

  it('keeps checks pointing at a file when it is renamed', async () => {
    const s = serve();
    mount();
    const path = await screen.findByLabelText('File 1 path');
    await userEvent.clear(path);
    await userEvent.type(path, 'main.py');
    expect(screen.getByLabelText('Check 1 program file')).toHaveValue('main.py');
    expect(screen.getByLabelText('Check 2 program file')).toHaveValue('main.py');
    await waitFor(
      () => {
        const sent = s.patched.at(-1)?.content as
          | { questions: { checks: { file: string }[] }[] }
          | undefined;
        expect(sent?.questions[0]?.checks.map((c) => c.file)).toEqual(['main.py', 'main.py']);
      },
      { timeout: 3000 },
    );
  });

  it('lists what publication says about the saved test, warnings apart from errors', async () => {
    serve({
      report: {
        errors: [
          {
            code: 'invalid_test',
            message: '“Spread check”: package torch is not available',
            resourceId: RESOURCE,
          },
        ],
        warnings: [
          {
            code: 'script_only_hidden_checks',
            message: '“Spread check”: every hidden check is a script check',
            resourceId: RESOURCE,
          },
          { code: 'empty_topic', message: 'Another topic is empty' },
        ],
      },
    });
    mount();
    const panel = await screen.findByRole('status', { name: 'Publication check' });
    expect(within(panel).getByText(/package torch is not available/)).toBeInTheDocument();
    expect(
      within(panel).getByText(/Warning: .*every hidden check is a script check/),
    ).toBeInTheDocument();
    expect(within(panel).queryByText(/Another topic/)).toBeNull();
  });

  it('adds a choice question that needs its options and a correct answer before it saves', async () => {
    const s = serve();
    mount();
    await screen.findByLabelText('Question 1 prompt and input/output contract');
    await userEvent.selectOptions(screen.getByLabelText('Question type'), 'choice');
    await userEvent.click(screen.getByRole('button', { name: 'Add question' }));
    expect(await screen.findByLabelText('Question 2 prompt')).toBeInTheDocument();
    expect(screen.getAllByText(/Question 2/).length).toBeGreaterThan(0);
    await userEvent.type(screen.getByLabelText('Question 2 prompt'), 'Which varies least?');
    await userEvent.type(screen.getByLabelText('Option 1 label'), 'n = 10');
    await userEvent.type(screen.getByLabelText('Option 2 label'), 'n = 100');
    await userEvent.click(screen.getByLabelText('Option 2 is correct'));
    await waitFor(() => expect(s.patched.at(-1)).toHaveProperty('content'), { timeout: 3000 });
    const sent = s.patched.at(-1)?.content as { questions: { id: string; correct?: string[] }[] };
    expect(sent.questions.map((q) => q.id)).toEqual(['mean', 'q2']);
    expect(sent.questions[1]?.correct).toEqual(['b']);
  });

  it('keeps the question being edited while its id changes', async () => {
    serve();
    mount();
    const id = await screen.findByLabelText('Question 1 id');
    await userEvent.type(id, '2');
    await userEvent.type(id, 'x');
    expect(id).toHaveValue('mean2x');
    expect(id).toHaveFocus();
    expect(screen.getByLabelText('Question 1 id')).toBe(id);
  });

  it('gives a new option an unused id and keeps the correct mark through a rename', async () => {
    const s = serve();
    mount();
    await screen.findByLabelText('Question 1 prompt and input/output contract');
    await userEvent.selectOptions(screen.getByLabelText('Question type'), 'choice');
    await userEvent.click(screen.getByRole('button', { name: 'Add question' }));
    await userEvent.type(await screen.findByLabelText('Question 2 prompt'), 'Which varies least?');
    const add = screen.getByRole('button', { name: 'Add option' });
    await userEvent.click(add);
    expect(screen.getByLabelText('Option 3 id')).toHaveValue('c');
    await userEvent.click(screen.getByRole('button', { name: 'Remove option 2' }));
    await userEvent.click(add);
    expect(screen.getByLabelText('Option 3 id')).toHaveValue('b');
    for (const [i, label] of [
      [1, 'n = 10'],
      [2, 'n = 100'],
      [3, 'n = 1000'],
    ] as const) {
      await userEvent.type(screen.getByLabelText(`Option ${i} label`), label);
    }
    await userEvent.click(screen.getByLabelText('Option 1 is correct'));
    const optionId = screen.getByLabelText('Option 1 id');
    await userEvent.clear(optionId);
    await userEvent.type(optionId, 'small');
    expect(screen.getByLabelText('Option 1 is correct')).toBeChecked();
    await waitFor(
      () => {
        const sent = s.patched.at(-1)?.content as
          | { questions: { options?: { id: string }[]; correct?: string[] }[] }
          | undefined;
        expect(sent?.questions[1]?.options?.map((o) => o.id)).toEqual(['small', 'c', 'b']);
        expect(sent?.questions[1]?.correct).toEqual(['small']);
      },
      { timeout: 3000 },
    );
  });

  it('stops polling a preview run whose result cannot be read', async () => {
    const s = serve({ readStatus: 500 });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Run sample checks' }));
    await waitFor(() => expect(s.reads).toBeGreaterThan(0));
    const reads = s.reads;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(s.reads).toBe(reads);
  });

  it('runs all checks of the saved question and shows hidden checks as hidden', async () => {
    const s = serve();
    mount();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Run all checks, hidden included' }),
    );
    await waitFor(() => expect(s.posted).toHaveLength(1));
    expect(s.posted[0]?.url).toBe(`${base}/resources/${RESOURCE}/questions/mean/preview-runs`);
    expect(s.posted[0]?.body).toEqual({
      set: 'full',
      files: [{ path: 'solution.py', content: 'def mean(xs):\n    pass\n' }],
    });
    const result = await screen.findByRole('status', { name: 'Preview run result' });
    await within(result).findByText(/Passed · all checks/);
    const hidden = within(result).getByText('hidden-large').closest('li');
    expect(hidden).toHaveTextContent('Hidden');
    expect(hidden).toHaveTextContent('failed');
    expect(hidden).toHaveTextContent('Expected: 42');
    expect(hidden).toHaveTextContent('Actual: 40');
  });

  it('says so when the instructor teaches no class to preview in', async () => {
    serve({ previewStatus: 409 });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Run sample checks' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Teach a class of this course');
  });

  it('says the class was archived when it was archived before the run was queued', async () => {
    serve({ previewStatus: 409, previewError: { error: 'class_archived' } });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Run sample checks' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('was archived');
  });

  it('keeps the answer-key radio groups of two open editors apart', async () => {
    const choice = {
      questions: [
        {
          id: 'q1',
          kind: 'choice',
          prompt: 'Pick one',
          points: 1,
          options: [
            { id: 'a', label: 'One' },
            { id: 'b', label: 'Two' },
          ],
          multiple: false,
          correct: ['a'],
          rubric: [],
        },
      ],
    };
    serve({ current: resource({ head: { ...resource().head, content: choice } }) });
    const queryClient = createQueryClient({ retry: false });
    render(
      <QueryClientProvider client={queryClient}>
        <TestEditor courseId={COURSE} resourceId={RESOURCE} onSaved={() => undefined} />
        <TestEditor courseId={COURSE} resourceId={RESOURCE} onSaved={() => undefined} />
      </QueryClientProvider>,
    );
    const radios = await screen.findAllByLabelText('Option 2 is correct');
    expect(radios).toHaveLength(2);
    await userEvent.click(radios[0] as HTMLElement);
    expect(radios[0]).toBeChecked();
    // The second editor's own answer key still shows its option 1, not unchecked by the first.
    const first = screen.getAllByLabelText('Option 1 is correct');
    expect(first[1]).toBeChecked();
    expect(radios[1]).not.toBeChecked();
  });
});

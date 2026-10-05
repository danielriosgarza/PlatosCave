import '@testing-library/jest-dom/vitest';
import { onlineManager } from '@tanstack/react-query';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
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
import type { AttemptView, Receipt } from './api';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
  // TanStack Query keeps its own online flag between tests and pauses every query while it is off.
  onlineManager.setOnline(true);
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RESOURCE = uuid(0xa1);
const ATTEMPT = uuid(0xa2);
const STARTER = 'def standard_error(values):\n    pass\n';
// `codeHash` of the server's job builder for these files (apps/server/src/execution/job-builder.ts).
const HASH_STARTER = '609795cd8f882ec1eb6d171f004bfa364b7dc3d67f1c7dde17cf162ad9525dad';

const terms = {
  attempts: 1,
  durationMinutes: null,
  opensAt: null,
  closesAt: '2026-10-20T16:00:00Z',
  timeZone: 'Europe/Madrid',
  late: { policy: 'none' as const },
  release: {
    results: 'manual' as const,
    at: null,
    solutions: 'never' as const,
    hiddenTestDetails: false,
  },
  reportedGrade: 'latest' as const,
  allowedMaterials: 'Course notes only',
  override: null,
  totalPoints: 10,
};

const questions: AttemptView['questions'] = [
  {
    kind: 'choice',
    id: 'q1',
    prompt: 'Which statistic describes the spread of sample means?',
    points: 2,
    multiple: false,
    options: [
      { id: 'sd', label: 'Standard deviation' },
      { id: 'se', label: 'Standard error' },
    ],
  },
  { kind: 'numeric', id: 'q2', prompt: 'What is SE for sd 3 and n 9?', points: 2, unit: 'units' },
  {
    kind: 'explanation',
    id: 'q3',
    prompt: 'Explain why larger samples narrow the distribution.',
    points: 2,
    maxLength: 500,
  },
  {
    kind: 'code',
    id: 'q4',
    prompt: 'Implement standard_error(values).',
    points: 4,
    runtime: 'python-3.12',
    allowedPackages: [],
    files: [{ path: 'solution.py', content: STARTER, editable: true }],
    limits: { wallSeconds: 10, memoryMiB: 512, outputBytes: 1048576 },
    sampleChecks: [],
  },
];

interface Options {
  /** Calls to `submit` whose response is lost after the server stored the submission. */
  dropSubmits?: number;
  deadlineAt?: string | null;
  runResult?: (n: number) => unknown;
}

/** An in-memory stand-in for the P3-15 and P3-16 routes: it keeps answers, receipts and runs. */
function testApi(options: Options = {}) {
  const me = makeMe({ classes: [studentIn(CLASS_A, 'Autumn 2026 A')] });
  const answers = new Map<
    string,
    { value: unknown; flagged: boolean; seq: number; savedAt: string }
  >();
  const log = {
    puts: [] as { id: string; body: { value: unknown; flagged: boolean; seq: number } }[],
    submits: [] as { key: string }[],
    localCopies: [] as { answers: { questionId: string; value: unknown }[] }[],
    runs: [] as { files: { path: string; content: string }[] }[],
    order: [] as string[],
  };
  const server = {
    receipt: null as Receipt | null,
    localCopyAt: null as string | null,
    offline: false,
  };
  let submitted = 0;
  const attemptView = (): AttemptView => ({
    id: ATTEMPT,
    number: 1,
    state: server.receipt ? 'submitted' : 'in_progress',
    resourceRevisionId: uuid(0xa3),
    startedAt: '2026-10-05T09:00:00Z',
    deadlineAt: options.deadlineAt ?? null,
    submittedAt: server.receipt?.submittedAt ?? null,
    receipt: server.receipt,
    localCopyAt: server.localCopyAt,
    graderVersion: 'g1',
    terms,
    questions,
    answers: [...answers].map(([questionId, a]) => ({ questionId, ...a })),
    serverNow: new Date().toISOString(),
  });
  const base = `/api/classes/${CLASS_A}`;
  const overview = {
    resourceId: RESOURCE,
    resourceRevisionId: uuid(0xa3),
    terms,
    questionCount: questions.length,
    attempts: [],
    eligibility: { canStart: true, reason: null, attemptsUsed: 0, attemptsAllowed: 1 },
    serverNow: new Date().toISOString(),
  };
  let runCount = 0;
  const stub = stubApi((url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const method = init?.method ?? 'GET';
    if (url === '/api/me') return { status: 200, body: me };
    if (/\/topics$/.test(url)) return { status: 200, body: makeTopics() };
    if (/\/reviews$/.test(url)) {
      return { status: 200, body: { topicId: T_SAMPLING, complete: false, items: [] } };
    }
    if (url === `${base}/release`) {
      return {
        status: 200,
        body: {
          release: { id: uuid(601), version: 1, createdAt: '2026-09-01T09:00:00Z' },
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
                  revisionId: uuid(0xa3),
                  type: 'test',
                  tab: 'tests',
                  position: 0,
                  title: 'Sampling and uncertainty',
                  visibility: 'visible',
                  releaseAt: null,
                  credit: null,
                },
              ],
            },
          ],
        },
      };
    }
    if (url === `${base}/resources/${RESOURCE}/test`) return { status: 200, body: overview };
    if (url === `${base}/resources/${RESOURCE}/test-attempts` && method === 'POST') {
      return { status: 200, body: attemptView() };
    }
    if (url === `${base}/test-attempts/${ATTEMPT}`) return { status: 200, body: attemptView() };
    const put = url.match(/\/answers\/([^/]+)$/);
    if (put && method === 'PUT') {
      const id = put[1] as string;
      log.puts.push({ id, body });
      log.order.push(`put:${id}`);
      if (server.receipt) {
        return { status: 409, body: { error: 'attempt_closed', receipt: server.receipt } };
      }
      const savedAt = new Date().toISOString();
      const held = answers.get(id);
      if (!held || body.seq > held.seq) {
        answers.set(id, { value: body.value, flagged: body.flagged, seq: body.seq, savedAt });
      }
      return { status: 200, body: { questionId: id, seq: body.seq, savedAt } };
    }
    if (url.endsWith('/submit')) {
      log.submits.push({ key: body.submissionKey });
      submitted += 1;
      server.receipt ??= {
        submissionId: uuid(0xb1),
        attemptId: ATTEMPT,
        submittedAt: new Date().toISOString(),
        autoSubmitted: false,
        late: false,
        answers: [...answers].map(([questionId, a]) => ({
          questionId,
          seq: a.seq,
          savedAt: a.savedAt,
        })),
        unanswered: questions.map((q) => q.id).filter((id) => !answers.has(id)),
      };
      return { status: 200, body: server.receipt };
    }
    if (url.endsWith('/local-copy')) {
      log.localCopies.push(body);
      server.localCopyAt = new Date().toISOString();
      return { status: 200, body: { localCopyAt: server.localCopyAt } };
    }
    if (/\/questions\/q4\/runs\?latest=1$/.test(url)) return { status: 200, body: { run: null } };
    if (/\/questions\/q4\/runs$/.test(url) && method === 'POST') {
      log.runs.push(body);
      log.order.push('run');
      runCount += 1;
      return { status: 202, body: { ...(options.runResult?.(runCount) as object), reused: false } };
    }
    return { status: 404, body: {} };
  });
  // A lost response: the server stored the submission, but the browser never hears of it.
  let drops = options.dropSubmits ?? 0;
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (server.offline) throw new TypeError('network down');
    const response = await real(input, init);
    if (String(input).endsWith('/submit') && drops > 0) {
      drops -= 1;
      // The response takes a moment to be lost, long enough for a second click to arrive.
      await new Promise((r) => setTimeout(r, 150));
      throw new TypeError('connection reset');
    }
    return response;
  });
  void stub;
  return {
    log,
    answers,
    server,
    get submitted() {
      return submitted;
    },
  };
}

const open = () => renderApp(`/classes/${CLASS_A}/topics/${T_SAMPLING}/tests`);

async function begin(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Start attempt 1' }));
  expect(await screen.findByRole('heading', { name: 'Question 1' })).toBeVisible();
}

const run = (n: number, overrides: object = {}) => ({
  runId: uuid(0xc0 + n),
  state: 'failed',
  codeHash: HASH_STARTER,
  queuedAt: '2026-10-05T09:01:00Z',
  finishedAt: '2026-10-05T09:01:02Z',
  result: {
    status: 'failed',
    runtime: { language: 'python', version: '3.12' },
    checks: [
      {
        name: 'four values',
        status: 'failed',
        durationMs: 12,
        expected: '1.290994',
        actual: 'None',
        stdout: '',
        stderr: '',
        truncated: false,
      },
    ],
    truncated: false,
    durationMs: 40,
    ...overrides,
  },
});

const enableScreenReaderMode = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: /Screen-reader mode/ }));
  return screen.getByRole('textbox', { name: 'solution.py, your implementation' });
};

describe('test UI: terms, navigation and answers', () => {
  it('A14 shows the effective terms before starting and in the prompt column during work', async () => {
    const user = userEvent.setup();
    testApi();
    open();
    const before = await screen.findByRole('region', { name: 'Assignment terms' });
    expect(within(before).getByText('Course notes only')).toBeVisible();
    expect(within(before).getByText('Released by your instructor')).toBeVisible();
    expect(within(before).getByText('Not accepted')).toBeVisible();
    expect(within(before).getByText(/20 Oct 2026, 18:00 CEST/)).toBeVisible();
    await begin(user);
    const during = screen.getByRole('region', { name: 'Assignment terms' });
    expect(within(during).getByText('Attempt 1 of 1')).toBeVisible();
    expect(within(during).getByText('Untimed')).toBeVisible();
  });

  it('A14 navigation labels each question Answered, Unanswered or Flagged', async () => {
    const user = userEvent.setup();
    testApi();
    open();
    await begin(user);
    const nav = screen.getByRole('navigation', { name: 'Questions' });
    expect(within(nav).getAllByText('Unanswered')).toHaveLength(4);
    await user.click(screen.getByRole('radio', { name: 'Standard error' }));
    await user.click(screen.getByRole('checkbox', { name: 'Flag for review' }));
    expect(within(nav).getByText('Answered · Flagged')).toBeVisible();
    expect(within(nav).getAllByText('Unanswered')).toHaveLength(3);
  });

  it('A14 an answer shows Saved only after the server acknowledges it', async () => {
    const user = userEvent.setup();
    const api = testApi();
    open();
    await begin(user);
    await user.click(screen.getByRole('radio', { name: 'Standard error' }));
    expect(screen.getByText('Unsaved changes')).toBeVisible();
    expect(screen.queryByText(/^Saved /)).toBeNull();
    expect(await screen.findByText(/^Saved \d/)).toBeVisible();
    expect(api.log.puts[0]).toMatchObject({ id: 'q1', body: { value: ['se'], seq: 1 } });
  });

  it('A14 a failed save keeps the answer, says it is not saved and offers Retry', async () => {
    const user = userEvent.setup();
    const api = testApi();
    open();
    await begin(user);
    await user.click(screen.getByRole('button', { name: 'Next question' }));
    api.server.offline = true;
    await user.type(screen.getByRole('textbox', { name: /Your answer/ }), '3');
    expect(await screen.findByText(/Not saved/)).toBeVisible();
    expect(screen.getByRole('textbox', { name: /Your answer/ })).toHaveValue('3');
    api.server.offline = false;
    await user.click(screen.getByRole('button', { name: 'Retry save' }));
    expect(await screen.findByText(/^Saved \d/)).toBeVisible();
    expect(api.answers.get('q2')?.value).toBe(3);
  });

  it('A14 text that is not a number is flagged and not saved', async () => {
    const user = userEvent.setup();
    const api = testApi();
    open();
    await begin(user);
    await user.click(screen.getByRole('button', { name: 'Next question' }));
    await user.type(screen.getByRole('textbox', { name: /Your answer/ }), 'abc');
    expect(screen.getByText(/Enter a number/)).toBeVisible();
    await new Promise((r) => setTimeout(r, 1000));
    expect(api.log.puts).toHaveLength(0);
  });
});

describe('test UI: Run sample tests', () => {
  async function toCode(user: ReturnType<typeof userEvent.setup>) {
    await begin(user);
    await user.click(screen.getByRole('button', { name: 'Question 4 Unanswered' }));
    return enableScreenReaderMode(user);
  }

  it('A12 the sample output names its code snapshot and goes out of date when the code changes', async () => {
    const user = userEvent.setup();
    const api = testApi({ runResult: (n) => run(n) });
    open();
    const editor = await toCode(user);
    await user.click(screen.getByRole('button', { name: 'Run sample tests' }));
    expect(await screen.findByText(/Output for snapshot 609795cd/)).toBeVisible();
    expect(screen.getByText(/Expected: 1.290994/)).toBeVisible();
    expect(screen.getByText(/Actual: None/)).toBeVisible();
    expect(screen.queryByText(/out of date/)).toBeNull();
    // The request carried the files the editor held.
    expect(api.log.runs[0]?.files).toEqual([{ path: 'solution.py', content: STARTER }]);
    await user.type(editor, ' # edit');
    expect(await screen.findByText(/Output is out of date/)).toBeVisible();
    expect(screen.getByText(/since snapshot 609795cd/)).toBeVisible();
  });

  it('A12 running saves the edited code first, so the run belongs to a saved snapshot', async () => {
    const user = userEvent.setup();
    const api = testApi({ runResult: (n) => run(n) });
    open();
    const editor = await toCode(user);
    await user.type(editor, '# edited');
    await user.click(screen.getByRole('button', { name: 'Run sample tests' }));
    await screen.findByText(/snapshot 609795cd|out of date/);
    expect(api.log.order).toEqual(['put:q4', 'run']);
    expect(api.answers.get('q4')?.value).toEqual({
      files: [{ path: 'solution.py', content: `${STARTER}# edited` }],
    });
  });

  it('A12 the code editor shows line numbers and is named for assistive technology', async () => {
    const user = userEvent.setup();
    testApi();
    open();
    await begin(user);
    await user.click(screen.getByRole('button', { name: 'Question 4 Unanswered' }));
    const editor = await screen.findByRole('textbox', { name: 'solution.py, your implementation' });
    expect(editor).toHaveAttribute('contenteditable', 'true');
    expect(editor.closest('.cm-editor')?.querySelector('.cm-lineNumbers')).not.toBeNull();
    expect(screen.getByRole('button', { name: /Screen-reader mode: off/ })).toBeVisible();
  });

  it('A12 a rerun of the same code is not labelled out of date', async () => {
    const user = userEvent.setup();
    testApi({ runResult: (n) => run(n) });
    open();
    const editor = await toCode(user);
    await user.type(editor, 'x');
    await user.type(editor, '{Backspace}');
    await user.click(screen.getByRole('button', { name: 'Run sample tests' }));
    expect(await screen.findByText(/Output for snapshot/)).toBeVisible();
    expect(screen.queryByText(/out of date/)).toBeNull();
  });

  it.each([
    [
      'a compile error',
      {
        status: 'failed',
        compileError: { file: 'solution.py', line: 2, message: 'SyntaxError: invalid syntax' },
        checks: [],
      },
      /Compile error/,
      /solution.py:2/,
    ],
    [
      'a runtime error',
      {
        status: 'failed',
        checks: [
          {
            name: 'four values',
            status: 'error',
            errorKind: 'exception',
            message: 'ZeroDivisionError: division by zero',
            durationMs: 3,
            stdout: '',
            stderr: '',
            truncated: false,
          },
        ],
      },
      /Runtime error · four values/,
      /ZeroDivisionError/,
    ],
    [
      'a timeout',
      {
        status: 'time_limited',
        checks: [
          {
            name: 'four values',
            status: 'timeout',
            durationMs: 10000,
            stdout: '',
            stderr: '',
            truncated: false,
          },
        ],
      },
      /Time limit reached/,
      /Timed out · four values/,
    ],
    [
      'resource exhaustion',
      {
        status: 'resource_exhausted',
        checks: [
          {
            name: 'four values',
            status: 'error',
            errorKind: 'memory',
            durationMs: 900,
            stdout: '',
            stderr: '',
            truncated: false,
          },
        ],
      },
      /Resource limit reached/,
      /Memory limit reached · four values/,
    ],
  ])('A12 shows %s distinctly', async (_name, result, headline, detail) => {
    const user = userEvent.setup();
    testApi({ runResult: (n) => run(n, result) });
    open();
    await toCode(user);
    await user.click(screen.getByRole('button', { name: 'Run sample tests' }));
    expect(await screen.findByText(headline)).toBeVisible();
    expect(screen.getByText(detail)).toBeVisible();
  });

  it('A12 an infrastructure failure says Run unavailable, keeps the code and uses no attempt', async () => {
    const user = userEvent.setup();
    testApi({
      runResult: (n) => ({ ...run(n), state: 'infrastructure_error', result: undefined }),
    });
    open();
    const editor = await toCode(user);
    await user.type(editor, '# keep');
    await user.click(screen.getByRole('button', { name: 'Run sample tests' }));
    expect(await screen.findByText(/Run unavailable/)).toBeVisible();
    expect(screen.getByText(/no attempt was used/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(editor).toHaveValue(`${STARTER}# keep`);
  });

  it('A12 a queued run shows its place in the queue and can be cancelled', async () => {
    const user = userEvent.setup();
    testApi({
      runResult: (n) => ({
        ...run(n),
        state: 'queued',
        queuePosition: 3,
        result: undefined,
        finishedAt: undefined,
      }),
    });
    open();
    await toCode(user);
    await user.click(screen.getByRole('button', { name: 'Run sample tests' }));
    expect(await screen.findByText(/3 runs ahead of yours/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBeVisible();
  });

  it('A12 the editor offers a downloadable draft and a screen-reader mode', async () => {
    const user = userEvent.setup();
    testApi();
    open();
    const create = vi.fn(() => 'blob:draft');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    // jsdom cannot follow a download link; the click itself is what the test observes.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await toCode(user);
    expect(screen.getByRole('button', { name: /Screen-reader mode: on/ })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Download draft' }));
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('test UI: submission', () => {
  async function reviewable(user: ReturnType<typeof userEvent.setup>) {
    await begin(user);
    await user.click(screen.getByRole('radio', { name: 'Standard error' }));
    await user.click(screen.getByRole('button', { name: 'Review submission' }));
    expect(await screen.findByRole('heading', { name: 'Review submission' })).toBeVisible();
  }

  it('A14 Review submission lists the unanswered questions and the effective deadline', async () => {
    const user = userEvent.setup();
    testApi({ deadlineAt: '2026-10-20T16:00:00Z' });
    open();
    await reviewable(user);
    expect(screen.getByText('3 of 4 questions have no answer:')).toBeVisible();
    const list = screen.getByRole('list', { name: 'Unanswered questions' });
    expect(
      within(list)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Question 2', 'Question 3', 'Question 4']);
    expect(screen.getByText(/Closes 20 Oct 2026, 18:00 CEST/)).toBeVisible();
  });

  it('A14 double-clicking Submit and retrying after a dropped response give one submission and one receipt', async () => {
    const user = userEvent.setup();
    const api = testApi({ dropSubmits: 1 });
    open();
    await reviewable(user);
    await user.dblClick(screen.getByRole('button', { name: 'Submit test' }));
    // The response was lost: nothing is shown as submitted.
    expect(await screen.findByText(/did not acknowledge the submission/)).toBeVisible();
    expect(api.log.submits).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Test submitted' })).toBeNull();
    expect(screen.queryByText(uuid(0xb1))).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry submit' }));
    expect(await screen.findByRole('heading', { name: 'Test submitted' })).toBeVisible();
    expect(screen.getByText(uuid(0xb1))).toBeVisible();
    // Every request carried the same key, and the server holds one submission.
    expect(api.log.submits).toHaveLength(2);
    expect(new Set(api.log.submits.map((s) => s.key)).size).toBe(1);
    expect(api.server.receipt?.submissionId).toBe(uuid(0xb1));
  });

  it('A14 the receipt appears only after the server answers, with the attempt and answers received', async () => {
    const user = userEvent.setup();
    testApi();
    open();
    await reviewable(user);
    await user.click(screen.getByRole('button', { name: 'Submit test' }));
    expect(await screen.findByRole('heading', { name: 'Test submitted' })).toBeVisible();
    expect(screen.getByText(`1 · ID ${ATTEMPT}`)).toBeVisible();
    expect(screen.getByText(/Question 1 \(saved/)).toBeVisible();
    expect(screen.getByText('Question 2, Question 3, Question 4')).toBeVisible();
  });

  it('A14 submitting is unavailable offline and the answers stay', async () => {
    const user = userEvent.setup();
    testApi();
    open();
    await reviewable(user);
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByRole('button', { name: 'Submit test' })).toBeDisabled();
    expect(screen.getByText(/Submitting is unavailable while you are offline/)).toBeVisible();
  });
});

describe('test UI: expiry', () => {
  it('A15 a timed attempt that expires offline reports what the server received and keeps the local copy', async () => {
    const user = userEvent.setup();
    const api = testApi({ deadlineAt: '2099-01-01T00:00:00Z' });
    open();
    await begin(user);
    // Q1 reaches the server.
    await user.click(screen.getByRole('radio', { name: 'Standard error' }));
    expect(await screen.findByText(/^Saved \d/)).toBeVisible();
    // The connection drops; the explanation is typed but never reaches the server.
    api.server.offline = true;
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    await user.click(screen.getByRole('button', { name: 'Question 3 Unanswered' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Your explanation' }),
      'Averages vary less',
    );
    expect(await screen.findByText(/Not saved/)).toBeVisible();
    // The deadline passes: the server submits the answers it had.
    api.server.receipt = {
      submissionId: uuid(0xb2),
      attemptId: ATTEMPT,
      submittedAt: '2026-10-05T09:30:00Z',
      autoSubmitted: true,
      late: false,
      answers: [{ questionId: 'q1', seq: 1, savedAt: '2026-10-05T09:10:00Z' }],
      unanswered: ['q2', 'q3', 'q4'],
    };
    api.server.offline = false;
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(await screen.findByRole('heading', { name: /Time ran out/ })).toBeVisible();
    expect(screen.getByText(/It received 1 answer/)).toBeVisible();
    expect(screen.getByText('Question 2, Question 3, Question 4')).toBeVisible();
    expect(screen.getByText('Submitted by the server at the deadline')).toBeVisible();
    // The unsent text is not claimed as submitted; it is kept for recovery once the server says so.
    expect(screen.getByText(/Unsent changes are not part of this submission/)).toBeVisible();
    await waitFor(() => expect(api.log.localCopies).toHaveLength(1));
    expect(api.log.localCopies[0]?.answers).toEqual([
      { questionId: 'q3', value: 'Averages vary less' },
    ]);
    expect(await screen.findByText(/were kept for your instructor/)).toBeVisible();
    expect(screen.getByText(/They are not submitted/)).toBeVisible();
  });

  it('A15 at the deadline the page asks the server and shows what the server submitted', async () => {
    const user = userEvent.setup();
    const api = testApi({ deadlineAt: new Date(Date.now() + 400).toISOString() });
    open();
    await begin(user);
    api.server.receipt = {
      submissionId: uuid(0xb3),
      attemptId: ATTEMPT,
      submittedAt: new Date().toISOString(),
      autoSubmitted: true,
      late: false,
      answers: [],
      unanswered: ['q1', 'q2', 'q3', 'q4'],
    };
    expect(await screen.findByRole('heading', { name: /Time ran out/ })).toBeVisible();
    expect(screen.getByText(/It received 0 answers/)).toBeVisible();
    expect(screen.queryByText(/Unsent changes are not part/)).toBeNull();
  });

  it('A15 reconnecting before the deadline reads the server state first and then sends unsent work', async () => {
    const user = userEvent.setup();
    const api = testApi({ deadlineAt: '2099-01-01T00:00:00Z' });
    open();
    await begin(user);
    api.server.offline = true;
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    await user.click(screen.getByRole('button', { name: 'Question 3 Unanswered' }));
    await user.type(screen.getByRole('textbox', { name: 'Your explanation' }), 'Offline words');
    expect(await screen.findByText(/Not saved/)).toBeVisible();
    api.server.offline = false;
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(api.answers.get('q3')?.value).toBe('Offline words'));
    expect(await screen.findByText(/^Saved \d/)).toBeVisible();
    expect(screen.queryByRole('heading', { name: /Time ran out/ })).toBeNull();
  });
});

describe('test UI: keyboard and screen reader', () => {
  it('A20 a keyboard user answers, reviews and submits without a pointer', async () => {
    const user = userEvent.setup();
    const api = testApi();
    open();
    const start = await screen.findByRole('button', { name: 'Start attempt 1' });
    start.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Question 1' })).toBeVisible();
    const option = screen.getByRole('radio', { name: 'Standard error' });
    option.focus();
    await user.keyboard(' ');
    expect(option).toBeChecked();
    const review = screen.getByRole('button', { name: 'Review submission' });
    review.focus();
    await user.keyboard('{Enter}');
    const heading = await screen.findByRole('heading', { name: 'Review submission' });
    expect(heading).toHaveFocus();
    const submit = screen.getByRole('button', { name: 'Submit test' });
    submit.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Test submitted' })).toBeVisible();
    expect(api.log.submits).toHaveLength(1);
  });

  it('A20 status changes are announced in a live region and the editor has an accessible name', async () => {
    const user = userEvent.setup();
    testApi();
    open();
    await begin(user);
    await user.click(screen.getByRole('radio', { name: 'Standard error' }));
    const status = (await screen.findByText(/^Saved \d/)).closest('[aria-live]');
    expect(status).toHaveAttribute('aria-live', 'polite');
    await user.click(screen.getByRole('button', { name: 'Question 4 Unanswered' }));
    const editor = await enableScreenReaderMode(user);
    expect(editor).toHaveAccessibleName('solution.py, your implementation');
  });
});

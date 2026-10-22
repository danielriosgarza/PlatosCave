import { openCourse, openPaths, openResource, openTopic } from '@parallax/contracts';
import hostile from '@parallax/contracts/fixtures/hostile-live-output.json';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { expectNoAxeViolations } from '../../test/axe';
import { createOpenApp } from '../app';
import { CONNECTOR_ORIGIN, ConnectorError, client, pairingCode } from './connector';
import { localShown } from './LocalRichOutput';
import { failureText } from './OpenRun';
import { chooseKernel, resetLocalRuns } from './session';

/**
 * A57: a level 0 notebook runs on the visitor's own computer through `parallax-connector open`,
 * and its outputs come back to the course page. The connector and its kernel channel are stubbed
 * here (`fetch` and `WebSocket`); e2e/open/a57-run-on-this-computer.e2e.ts runs the real ones.
 */

const COURSE = 'reef-ecology';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [TOPIC, NOTEBOOK, SESSION, KERNEL] = [uuid(1), uuid(5), uuid(20), uuid(21)];
const KEY = '0123456789abcdef'.repeat(4);
const CONTENT = 'https://content.reef.example.org/o/';
const FILE = `${CONTENT}${'b'.repeat(64)}.ipynb`;
const ZIP = `${CONTENT}${'e'.repeat(64)}.zip`;
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PAGE = openPaths.topic(COURSE, TOPIC, 'notebooks');

/** The data files of a course with one topic and one notebook, each through its schema. */
function site() {
  const presence = {
    ...{ slides: false, reading: false, exercises: false },
    ...{ notebooks: true, tests: false },
  };
  const topic = { topicId: TOPIC, number: 1, title: 'Sampling', estimatedMinutes: null, presence };
  const course = {
    title: 'Reef ecology',
    instructors: ['Ana Lima'],
    topics: [{ ...topic, objective: '', firstTab: 'notebooks' }],
  };
  const lists = {
    ...{ slides: [], reading: [], exercises: [], tests: [] },
    notebooks: [{ resourceId: NOTEBOOK, title: 'Quadrat counts', type: 'notebook' }],
  };
  const stored = { type: 'text', executionCount: null, stream: 'stdout', truncated: false };
  const cells = [
    { id: 'm', type: 'markdown', html: '<p>Count the quadrats.</p>' },
    {
      ...{ id: 'c1', type: 'code', source: "print('RUN')", executionCount: 1 },
      ...{ sourceHidden: false, outputsHidden: false, outputs: [{ ...stored, text: 'STORED\n' }] },
    },
    {
      ...{ id: 'c2', type: 'code', source: 'plot(rows)', executionCount: 2 },
      ...{ sourceHidden: false, outputsHidden: false, outputs: [] },
    },
  ];
  const notebook = { kernel: 'Python 3', language: 'python', outline: [], cells };
  const file = (address: string, schema: { parse(value: unknown): unknown }, value: unknown) =>
    [address, JSON.stringify(schema.parse(value))] as const;
  return new Map([
    file(openPaths.courseData(COURSE), openCourse, course),
    file(openPaths.topicData(COURSE, TOPIC), openTopic, lists),
    file(openPaths.resourceData(COURSE, TOPIC, NOTEBOOK), openResource, {
      ...{ type: 'notebook', title: 'Quadrat counts', file: FILE, data: ZIP, notebook },
    }),
  ]);
}

/** What the connector answers, by request; a test replaces one to change it. */
type Reply = { status: number; body?: unknown };
const opened = {
  session: SESSION,
  folder: 'local-127.0.0.1-4175/reef-ecology/Quadrat counts',
  jupyter: '2.21.1',
  runtime: 'Python 3.12.3',
  kernelspecs: [
    { name: 'ir', displayName: 'R', language: 'R' },
    { name: 'python3', displayName: 'Python 3', language: 'python' },
  ],
  files: { written: ['counts.ipynb', 'data/quadrats.csv'], kept: [] as string[] },
};
const DEFAULT_ANSWERS = {
  hello: (): Reply => ({ status: 200, body: { api: 1, version: '1.4.0' } }),
  pair: (_body: unknown): Reply | Promise<Reply> => ({ status: 200, body: { key: KEY } }),
  open: (_body: unknown): Reply => ({ status: 201, body: opened }),
  kernel: (_body: unknown): Reply => ({
    status: 201,
    body: { id: KERNEL, name: 'python3', execution_state: 'starting' },
  }),
  other: (_method: string, _path: string): Reply => ({ status: 204 }),
};
let answers = { ...DEFAULT_ANSWERS };

function route(method: string, path: string, body: unknown): Reply | Promise<Reply> {
  if (path === '/v1/hello') return answers.hello();
  if (path === '/v1/pair') return answers.pair(body);
  if (path === '/v1/sessions' && method === 'POST') return answers.open(body);
  if (path.endsWith('/kernels') && method === 'POST') return answers.kernel(body);
  return answers.other(method, path);
}

/** Every request the page made, to the site or to the connector. */
interface Sent {
  url: string;
  method: string;
  credentials?: RequestCredentials;
  authorization: string | null;
  body?: unknown;
}
let requests: Sent[] = [];
const toConnector = () => requests.filter((r) => r.url.startsWith(CONNECTOR_ORIGIN));

function stubFetch(served: Map<string, string>) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const authorization = new Headers(init?.headers).get('Authorization');
    requests.push({ url, method, credentials: init?.credentials, authorization, body });
    if (url.startsWith(`${CONNECTOR_ORIGIN}/`)) {
      // A connector that does not run: the browser's fetch rejects.
      const reply = await route(method, url.slice(CONNECTOR_ORIGIN.length), body);
      const text = reply.body === undefined ? null : JSON.stringify(reply.body);
      return new Response(text, { status: reply.status });
    }
    const file = served.get(url);
    return file === undefined ? new Response('', { status: 404 }) : new Response(file);
  });
}

function open() {
  stubFetch(site());
  window.history.replaceState(null, '', PAGE);
  render(createOpenApp().element);
}

/** The kernel channel the connector bridges, driven by hand: Jupyter's own messages. */
class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: { header: { msg_id: string; msg_type: string; session: string }; content: unknown }[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    act(() => this.onopen?.());
  }
  /** One kernel message, answering `parent` (a request the page sent) or nobody's. */
  receive(type: string, parent: string | null, content: object, channel = 'iopub') {
    const message = {
      header: { msg_id: crypto.randomUUID(), msg_type: type, session: 'kernel', version: '5.3' },
      parent_header: parent === null ? {} : { msg_id: parent },
      metadata: {},
      content,
      channel,
    };
    act(() => this.onmessage?.({ data: JSON.stringify(message) }));
  }
  drop() {
    this.readyState = 3;
    act(() => this.onclose?.({ code: 1006 }));
  }
  requests(type: string) {
    return this.sent.filter((m) => m.header.msg_type === type);
  }
}
const lastSocket = () => FakeSocket.all[FakeSocket.all.length - 1] as FakeSocket;

const cellSection = (id: string) =>
  document.querySelector<HTMLElement>(`[data-cell-id="${id}"]`) as HTMLElement;
const runButton = (id: string) =>
  within(cellSection(id)).getByRole('button', { name: /^Run cell/ });
const mode = () => screen.getByText(/^This computer · /);

/** Opens the notebook, chooses Run on this computer and Connect, and opens the kernel channel. */
async function connectNotebook() {
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Run on this computer' }));
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await screen.findByText(/^This computer · /);
  // The channel opens in an effect after the notebook is shown.
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  const socket = lastSocket();
  socket.open();
  const [info] = socket.requests('kernel_info_request');
  socket.receive('kernel_info_reply', info?.header.msg_id ?? null, { status: 'ok' }, 'shell');
  return socket;
}

/** Runs a cell and answers it as Jupyter does: busy, `outputs`, the reply, idle. */
function runAndAnswer(socket: FakeSocket, cellId: string, outputs: [string, object][]) {
  fireEvent.click(runButton(cellId));
  const request = socket.requests('execute_request').at(-1);
  const parent = request?.header.msg_id ?? null;
  socket.receive('status', parent, { execution_state: 'busy' });
  for (const [type, content] of outputs) socket.receive(type, parent, content);
  return {
    request,
    finish: (count: number) => {
      socket.receive('execute_reply', parent, { status: 'ok', execution_count: count }, 'shell');
      socket.receive('status', parent, { execution_state: 'idle' });
    },
  };
}

beforeAll(() => {
  // jsdom has no layout; CodeMirror measures text ranges.
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
beforeEach(() => {
  answers = { ...DEFAULT_ANSWERS };
  requests = [];
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => {
  cleanup();
  resetLocalRuns();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
  delete (window as { __pwned?: unknown }).__pwned;
});

describe('A57 run a level 0 notebook on this computer', () => {
  test('A57 the page reaches the connector only after Connect, and the terminal is asked with the code it shows', async () => {
    let answer: (reply: Reply) => void = () => {};
    answers.pair = () => new Promise<Reply>((resolve) => (answer = resolve));
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Run on this computer' }));
    expect(screen.getByRole('heading', { name: 'Run on this computer' })).toHaveFocus();
    expect(screen.getByText('parallax-connector open')).toBeInTheDocument();
    // Opening the panel asks nothing of this computer.
    expect(toConnector()).toEqual([]);
    await expectNoAxeViolations(document.body);

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    const status = await screen.findByText(/It shows the code/);
    const code = within(status).getByText(/^\d{4}-\d{4}$/).textContent;
    expect(toConnector().map((r) => [r.method, r.url, r.body])).toEqual([
      ['GET', `${CONNECTOR_ORIGIN}/v1/hello`, undefined],
      ['POST', `${CONNECTOR_ORIGIN}/v1/pair`, { code }],
    ]);
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();

    await act(async () => answer({ status: 200, body: { key: KEY } }));
    await screen.findByText(/^This computer · /);
    await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
    // The notebook's folder below the site's, and its files from the content origin.
    const [, , start, kernel] = toConnector();
    expect(start).toMatchObject({
      method: 'POST',
      url: `${CONNECTOR_ORIGIN}/v1/sessions`,
      body: { folder: [COURSE, 'Quadrat counts'], files: ZIP },
    });
    // The notebook's own kernel, by the name it shows, though another comes first.
    expect(kernel).toMatchObject({
      url: `${start?.url}/${SESSION}/kernels`,
      body: { name: 'python3' },
    });
    for (const request of toConnector()) {
      expect(request.credentials).toBe('omit');
      expect(request.authorization).toBe(
        request.url.endsWith('/hello') || request.url.endsWith('/pair') ? null : `Bearer ${KEY}`,
      );
    }
    // The channel carries the key in its query: a WebSocket cannot send a header.
    const url = new URL(lastSocket().url);
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(
      `ws://127.0.0.1:47821/v1/sessions/${SESSION}/kernels/${KERNEL}/channels`,
    );
    expect(url.searchParams.get('key')).toBe(KEY);
    // Where the files are on this computer, and nothing about a token, a port or a home folder.
    expect(
      screen.getByText(/The notebook's files are in local-127.0.0.1-4175\/reef-ecology/),
    ).toBeInTheDocument();
  });

  test('A57 a cell runs on this computer and its outputs, images and frames return to the page', async () => {
    const socket = await connectNotebook();
    expect(mode()).toHaveTextContent('This computer · Python · Ready');
    // Opening the notebook never runs a cell.
    expect(socket.requests('execute_request')).toEqual([]);
    const { request, finish } = runAndAnswer(socket, 'c1', [
      ['stream', { name: 'stdout', text: 'RUN\n' }],
      ['display_data', { data: { 'image/png': PNG, 'text/plain': 'Counts per quadrat' } }],
      ['display_data', { data: hostile.html }],
      ['display_data', { data: hostile.svg }],
      ['execute_result', { execution_count: 1, data: hostile.markdown }],
    ]);
    expect(request?.content).toMatchObject({ code: "print('RUN')", allow_stdin: true });
    // One Jupyter session for the page: the channel's and each request's.
    expect(request?.header.session).toBe(new URL(socket.url).searchParams.get('session_id'));
    // A message that answers nothing this page sent is not shown.
    socket.receive('stream', null, { name: 'stdout', text: 'NOT MINE\n' });
    socket.receive('stream', crypto.randomUUID(), { name: 'stdout', text: 'NOT MINE\n' });
    finish(1);

    const cell = cellSection('c1');
    expect(cell).toHaveTextContent('RUN');
    expect(cell).not.toHaveTextContent('STORED');
    expect(cell).not.toHaveTextContent('NOT MINE');
    expect(cell).toHaveTextContent('Finished');
    const image = within(cell).getByRole('img', { name: 'Counts per quadrat' });
    expect(image).toHaveAttribute('src', `data:image/png;base64,${PNG}`);
    // HTML in a frame with every sandbox restriction, sanitised, under a policy that loads nothing.
    const frame = within(cell).getByTitle(/^Output of cell/);
    expect(frame).toHaveAttribute('sandbox', '');
    const doc = frame.getAttribute('srcdoc') ?? '';
    expect(doc).toContain(`content="default-src 'none'; img-src data:;`);
    expect(doc).toContain('x online = 3');
    for (const banned of ['<script', 'onclick', 'onerror', 'javascript:', '<iframe', '<object'])
      expect(doc).not.toContain(banned);
    expect(within(cell).getByText('Scripts in this output were removed and not run')).toBeVisible();
    // SVG only as an image: it runs nothing.
    const svg = within(cell).getByRole('img', { name: '<Figure size 640x480>' });
    expect(svg.getAttribute('src')).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    // Markdown as its source, not as markup on this page.
    expect(cell).toHaveTextContent('**bold**');
    expect(cell.querySelector('script, [onerror], [onload], [onclick]')).toBeNull();
    expect((window as { __pwned?: unknown }).__pwned).toBeUndefined();
    expect(mode()).toHaveTextContent('This computer · Python · Ready');
  });

  test('A57 a dropped channel leaves the cell Unconfirmed, and Connect again runs nothing again', async () => {
    const socket = await connectNotebook();
    runAndAnswer(socket, 'c2', [['stream', { name: 'stdout', text: 'half\n' }]]);
    expect(mode()).toHaveTextContent('Running');
    socket.drop();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The connection to the connector on this computer was lost.',
    );
    expect(cellSection('c2')).toHaveTextContent('Unconfirmed');
    expect(cellSection('c2')).toHaveTextContent('half');
    expect(runButton('c1')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Connect again' }));
    const again = lastSocket();
    expect(again).not.toBe(socket);
    expect(again.url).toBe(socket.url);
    again.open();
    // The same kernel; the page asks whether it listens and sends nothing to run.
    expect(again.sent.map((m) => m.header.msg_type)).toEqual(['kernel_info_request']);
    const [info] = again.requests('kernel_info_request');
    again.receive('kernel_info_reply', info?.header.msg_id ?? null, { status: 'ok' }, 'shell');
    expect(cellSection('c2')).toHaveTextContent('Unconfirmed');
    expect(runButton('c1')).toBeEnabled();
  });

  test('A57 Stop session stops the notebook on this computer and shows its saved outputs again', async () => {
    await connectNotebook();
    fireEvent.click(screen.getByRole('button', { name: 'Session' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    const confirm = screen.getByRole('region', { name: 'Stop session' });
    expect(confirm).toHaveTextContent('The files in its folder stay');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Stop session' }));
    expect(await screen.findByText('Saved outputs')).toBeInTheDocument();
    expect(toConnector().at(-1)).toMatchObject({
      method: 'DELETE',
      url: `${CONNECTOR_ORIGIN}/v1/sessions/${SESSION}`,
      authorization: `Bearer ${KEY}`,
    });
    expect(cellSection('c1')).toHaveTextContent('STORED');
  });

  test('A57 the files the visitor already had are kept, and the page says so', async () => {
    answers.open = () => ({
      status: 201,
      body: { ...opened, files: { written: ['counts.ipynb'], kept: ['data/quadrats.csv'] } },
    });
    await connectNotebook();
    expect(
      screen.getByText(/Your own version of data\/quadrats.csv was kept, not replaced\./),
    ).toBeInTheDocument();
  });

  test('A57 without a connector, or refused by its terminal, the page says what to do', async () => {
    answers.hello = () => {
      throw new TypeError('Failed to fetch');
    };
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Run on this computer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No connector answered on this computer. Start parallax-connector open in a terminal',
    );
    expect(toConnector().map((r) => r.url)).toEqual([`${CONNECTOR_ORIGIN}/v1/hello`]);

    answers.hello = DEFAULT_ANSWERS.hello;
    answers.pair = () => ({ status: 403, body: { code: 'refused', detail: 'refused' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        "The connector's terminal refused this site.",
      ),
    );
    expect(toConnector().filter((r) => r.url.endsWith('/v1/sessions'))).toEqual([]);
    expect(FakeSocket.all).toEqual([]);
  });

  test('A57 a connector started again since the page connected is asked once more', async () => {
    let opens = 0;
    answers.open = () =>
      ++opens === 1
        ? { status: 401, body: { code: 'not_paired', detail: 'unknown key' } }
        : { status: 201, body: opened };
    const socket = await connectNotebook();
    expect(toConnector().filter((r) => r.url.endsWith('/v1/pair'))).toHaveLength(2);
    expect(socket.url).toContain(`/v1/sessions/${SESSION}/`);
  });
});

describe('A57 parts', () => {
  test('A57 the client reaches only the connector on this computer, without credentials', async () => {
    stubFetch(new Map());
    const page = client(KEY);
    await page.interrupt(SESSION, KERNEL);
    await page.restart(SESSION, KERNEL);
    await page.stop(SESSION);
    expect(requests.map((r) => [r.method, r.url, r.credentials, r.authorization])).toEqual([
      [
        'POST',
        `${CONNECTOR_ORIGIN}/v1/sessions/${SESSION}/kernels/${KERNEL}/interrupt`,
        'omit',
        `Bearer ${KEY}`,
      ],
      [
        'POST',
        `${CONNECTOR_ORIGIN}/v1/sessions/${SESSION}/kernels/${KERNEL}/restart`,
        'omit',
        `Bearer ${KEY}`,
      ],
      ['DELETE', `${CONNECTOR_ORIGIN}/v1/sessions/${SESSION}`, 'omit', `Bearer ${KEY}`],
    ]);
    expect(CONNECTOR_ORIGIN).toBe('http://127.0.0.1:47821');
    for (let i = 0; i < 20; i++) expect(pairingCode()).toMatch(/^\d{4}-\d{4}$/);
  });

  test('A57 the kernel is the notebook own when this computer has it, else one of its language', () => {
    const specs = opened.kernelspecs;
    expect(chooseKernel(specs, { kernel: 'Python 3', language: 'python' })).toBe('python3');
    expect(chooseKernel(specs, { kernel: 'ir', language: null })).toBe('ir');
    expect(chooseKernel(specs, { kernel: 'Julia 1.10', language: 'Python' })).toBe('python3');
    expect(chooseKernel(specs, { kernel: null, language: null })).toBe('ir');
    expect(chooseKernel([], { kernel: 'Python 3', language: 'python' })).toBeNull();
    expect(chooseKernel(null, { kernel: 'Python 3', language: 'python' })).toBeNull();
  });

  test('A57 live outputs are shown without running anything they carry', () => {
    expect(localShown({ 'image/png': `${PNG}\n`, 'text/plain': 'x' })).toEqual({
      kind: 'image',
      src: `data:image/png;base64,${PNG}`,
      alt: 'x',
    });
    // Not base64: the next representation is shown.
    expect(localShown({ 'image/png': 'javascript:alert(1)', 'text/plain': 'x' })).toEqual({
      kind: 'text',
      text: 'x',
    });
    const html = localShown({ 'text/html': '<b>4</b><meta http-equiv="refresh" content="0;x">' });
    expect(html).toMatchObject({ kind: 'html', scriptsRemoved: false });
    expect(html.kind === 'html' && html.srcDoc).toContain('<b>4</b>');
    expect(html.kind === 'html' && html.srcDoc.match(/<meta/g)).toHaveLength(2);
    expect(localShown({ 'text/latex': '$x^2$', 'text/plain': 'x**2' })).toEqual({
      kind: 'text',
      text: 'x**2',
    });
    expect(
      localShown({ 'text/latex': '$x^2$', 'text/plain': '<IPython.core.display.Latex object>' }),
    ).toEqual({ kind: 'text', text: '$x^2$' });
    expect(localShown({ 'application/json': { a: 1 } })).toEqual({
      kind: 'text',
      text: '{\n  "a": 1\n}',
    });
    // JavaScript and widgets are never run.
    expect(
      localShown({
        'application/javascript': 'window.__pwned = 1',
        'application/vnd.jupyter.widget-view+json': { model_id: 'm' },
      }),
    ).toEqual({
      kind: 'unsupported',
      mimeTypes: ['application/javascript', 'application/vnd.jupyter.widget-view+json'],
    });
  });

  test('A57 each refusal of the connector is said in the visitor terms', () => {
    const said = (code: string, detail?: string) =>
      failureText(new ConnectorError(code, 400, detail));
    expect(said('no_answer')).toMatch(/^Nobody answered in the connector's terminal/);
    expect(said('cannot_ask')).toMatch(/has no terminal to ask in/);
    expect(said('busy')).toMatch(/asking about another page/);
    expect(said('too_many_sessions')).toMatch(/^Three notebooks already run on this computer/);
    expect(said('files_unavailable', 'the zip did not match')).toMatch(/the zip did not match$/);
    expect(said('origin_refused')).toBe('The connector does not serve pages of this site.');
    expect(said('kernel_start_failed')).not.toMatch(/kernel_start_failed/);
    expect(failureText(new Error('x'))).toBe('Connecting failed. Try again.');
  });
});

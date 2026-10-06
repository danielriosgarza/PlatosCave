import { EditorView } from '@codemirror/view';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../session/revocation';
import { CLASS_A, stubApi } from '../../test/render';
import type { NotebookSession } from '../connect/api';
import { session } from '../connect/fixtures';
import type { Notebook } from '../notebooks';
import { LiveNotebook, modeLabel } from './LiveNotebook';

const EPOCH = '00000000-0000-4000-8000-0000000f0001';
const KERNEL = '00000000-0000-4000-8000-0000000f0002';
const exec = (n: number) => `00000000-0000-4000-8000-0000000e${String(n).padStart(4, '0')}`;

/** A WebSocket the test drives by hand: nothing here talks to a network. */
class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
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
  receive(message: Record<string, unknown>) {
    act(() => this.onmessage?.({ data: JSON.stringify({ v: 1, ...message }) }));
  }
  drop(code = 1006) {
    this.readyState = 3;
    act(() => this.onclose?.({ code }));
  }
  frames(t: string) {
    return this.sent.filter((m) => m.t === t);
  }
}
const last = () => FakeSocket.all[FakeSocket.all.length - 1] as FakeSocket;

const ready = (over: Record<string, unknown> = {}) => ({
  t: 'ready',
  epoch: EPOCH,
  eventSeq: 0,
  session: {
    state: 'ready',
    cause: null,
    owned: true,
    lease: { idleTimeoutMin: 30, gracePeriodMin: 5 },
  },
  kernel: { id: KERNEL, name: 'python3', state: 'idle', generation: 0 },
  ...over,
});

const code = (id: string, source: string): Notebook['cells'][number] => ({
  id,
  type: 'code',
  source,
  executionCount: null,
  sourceHidden: false,
  outputsHidden: false,
  outputs: [],
});

const notebook: Notebook = {
  kernel: 'Python 3',
  language: 'python',
  outline: [],
  cells: [
    { id: 'intro', type: 'markdown', html: '<h1>Repeated samples</h1>' },
    code('c1', 'x = 1'),
    code('c2', 'raise ValueError("bad")'),
    code('c3', 'print(3)'),
  ],
};

const posts: { url: string; body: unknown }[] = [];

function mount(over: Partial<NotebookSession> = {}) {
  posts.length = 0;
  stubApi((url, init) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return { status: 202, body: session({ ...over }) };
    }
    return { status: 404, body: {} };
  });
  const onOpenConnect = vi.fn();
  const view = render(
    <QueryClientProvider client={createQueryClient()}>
      <LiveNotebook
        classId={CLASS_A}
        session={session(over)}
        connectionName="Lab workstation"
        notebook={notebook}
        outlineOpen={false}
        lead={(label) => <span data-testid="mode">{label}</span>}
        trail={null}
        onOpenConnect={onOpenConnect}
      />
    </QueryClientProvider>,
  );
  return { view, onOpenConnect };
}

/** Mounts, opens the socket and answers `hello` with a ready kernel. */
function attach(over: Partial<NotebookSession> = {}, readyOver: Record<string, unknown> = {}) {
  const m = mount(over);
  const socket = last();
  socket.open();
  socket.receive(ready(readyOver));
  return { ...m, socket };
}

const cellSection = (id: string) =>
  document.querySelector<HTMLElement>(`[data-cell-id="${id}"]`) as HTMLElement;
const runOf = (id: string) => within(cellSection(id)).getByRole('button', { name: /Run cell/ });

beforeAll(() => {
  // jsdom has no layout; CodeMirror measures text ranges.
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('live notebook', () => {
  it('A27 output returns to the same full-width notebook', () => {
    const { socket } = attach();
    expect(screen.getByTestId('mode')).toHaveTextContent('Lab workstation · Python · Ready');
    fireEvent.click(runOf('c1'));
    const [sent] = socket.frames('execute');
    expect(sent).toMatchObject({ cellId: 'c1', code: 'x = 1' });
    socket.receive({
      t: 'execution',
      executionId: exec(1),
      ref: sent?.ref,
      cellId: 'c1',
      seq: 1,
      state: 'running',
      outputsIncomplete: false,
      generation: 0,
    });
    socket.receive({
      t: 'output',
      executionId: exec(1),
      eventSeq: 1,
      generation: 0,
      kind: 'output',
      output: { output_type: 'stream', name: 'stdout', text: 'one\n' },
    });
    socket.receive({
      t: 'output',
      executionId: exec(1),
      eventSeq: 2,
      generation: 0,
      kind: 'output',
      output: { output_type: 'stream', name: 'stdout', text: 'two\n' },
    });
    const notebookEl = screen.getByRole('article', { name: 'Live notebook' });
    // The output is inside the notebook, under the cell that ran, and grew in place.
    const section = within(notebookEl).getByLabelText('Code cell 2 [ ]');
    expect(section).toHaveTextContent('one');
    expect(section).toHaveTextContent('two');
    expect(section).toHaveTextContent('Running');
    socket.receive({
      t: 'execution',
      executionId: exec(1),
      ref: sent?.ref,
      cellId: 'c1',
      seq: 1,
      state: 'ok',
      executionCount: 1,
      outputsIncomplete: false,
      generation: 0,
    });
    expect(cellSection('c1')).toHaveTextContent('Finished');
    expect(within(cellSection('c1')).getByText('[1]')).toBeInTheDocument();
  });

  it('A27 Ready is not shown before the kernel is idle', () => {
    const { socket } = attach(
      {},
      { kernel: { id: KERNEL, name: 'python3', state: 'starting', generation: 0 } },
    );
    expect(screen.getByTestId('mode')).toHaveTextContent('Starting');
    expect(screen.getByTestId('mode')).not.toHaveTextContent('Ready');
    expect(runOf('c1')).toBeDisabled();
    socket.receive({ t: 'kernel_state', state: 'idle', generation: 0 });
    expect(screen.getByTestId('mode')).toHaveTextContent('Ready');
    expect(runOf('c1')).toBeEnabled();
    expect(
      modeLabel({
        connectionName: undefined,
        language: 'Python',
        sessionState: 'ready',
        kernelState: 'idle',
        confirmed: false,
      }),
    ).toBe('Computer · Python · Unconfirmed');
  });

  it('A27 opening the notebook never runs a cell', () => {
    const { socket } = attach();
    expect(socket.frames('execute')).toHaveLength(0);
    expect(socket.frames('hello')).toHaveLength(1);
  });

  it('A31 a dropped socket reattaches and the cell is not run again', () => {
    vi.useFakeTimers();
    const { socket } = attach();
    fireEvent.click(runOf('c1'));
    const [first] = socket.frames('execute');
    // The relay acknowledged it, then the socket dropped with output in flight.
    socket.receive({
      t: 'execution',
      executionId: exec(1),
      ref: first?.ref,
      cellId: 'c1',
      seq: 1,
      state: 'running',
      outputsIncomplete: false,
      generation: 0,
    });
    socket.receive({
      t: 'output',
      executionId: exec(1),
      eventSeq: 4,
      generation: 0,
      kind: 'output',
      output: { output_type: 'stream', name: 'stdout', text: 'a\n' },
    });
    socket.drop();
    expect(runOf('c1')).toBeDisabled();
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(FakeSocket.all).toHaveLength(2);
    const second = last();
    second.open();
    // It resumes from the last event it applied, in the same epoch.
    expect(second.frames('hello')[0]).toMatchObject({ resume: { epoch: EPOCH, afterEventSeq: 4 } });
    second.receive(ready({ eventSeq: 5 }));
    second.receive({
      t: 'output',
      executionId: exec(1),
      eventSeq: 4,
      generation: 0,
      kind: 'output',
      output: { output_type: 'stream', name: 'stdout', text: 'a\n' },
    });
    second.receive({
      t: 'output',
      executionId: exec(1),
      eventSeq: 5,
      generation: 0,
      kind: 'output',
      output: { output_type: 'stream', name: 'stdout', text: 'b\n' },
    });
    // The replayed event is not shown twice, and no execute went out on either socket again.
    expect(cellSection('c1')).toHaveTextContent(/a\s+b/);
    expect(cellSection('c1').textContent?.match(/a\n/g)?.length ?? 1).toBe(1);
    expect(second.frames('execute')).toHaveLength(0);
    expect(socket.frames('execute')).toHaveLength(1);
  });

  it('A31 an execute nothing answered is resent only with its original ref', () => {
    vi.useFakeTimers();
    const { socket } = attach();
    fireEvent.click(runOf('c1'));
    const [first] = socket.frames('execute');
    socket.drop();
    act(() => {
      vi.advanceTimersByTime(600);
    });
    const second = last();
    second.open();
    second.receive(ready());
    const resent = second.frames('execute');
    expect(resent).toHaveLength(1);
    expect(resent[0]?.ref).toBe(first?.ref);
    expect(resent[0]).toMatchObject({ cellId: 'c1', code: 'x = 1' });
    // Once the relay answers, a later reconnect resends nothing.
    second.receive({
      t: 'execution',
      executionId: exec(1),
      ref: first?.ref,
      cellId: 'c1',
      seq: 1,
      state: 'unconfirmed',
      outputsIncomplete: true,
      generation: 0,
    });
    second.drop();
    act(() => {
      vi.advanceTimersByTime(600);
    });
    const third = last();
    third.open();
    third.receive(ready());
    expect(third.frames('execute')).toHaveLength(0);
    expect(cellSection('c1')).toHaveTextContent('Unconfirmed');
  });

  it('A31 an incomplete output is labelled and offers Run again', () => {
    const { socket } = attach();
    fireEvent.click(runOf('c1'));
    const [first] = socket.frames('execute');
    socket.receive({
      t: 'execution',
      executionId: exec(1),
      ref: first?.ref,
      cellId: 'c1',
      seq: 1,
      state: 'incomplete',
      outputsIncomplete: true,
      generation: 0,
    });
    const section = cellSection('c1');
    expect(section).toHaveTextContent('Incomplete');
    expect(section).toHaveTextContent('Parallax cannot tell whether it finished');
    // Nothing ran it again by itself.
    expect(socket.frames('execute')).toHaveLength(1);
    fireEvent.click(within(section).getByRole('button', { name: 'Run again' }));
    const executes = socket.frames('execute');
    expect(executes).toHaveLength(2);
    expect(executes[1]?.ref).not.toBe(executes[0]?.ref);
  });

  it('A31 lost kernel needs an explicit new session', async () => {
    const { socket } = attach(
      { cause: 'kernel_lost' },
      {
        kernel: null,
        session: {
          state: 'ready',
          cause: 'kernel_lost',
          owned: true,
          lease: { idleTimeoutMin: 30, gracePeriodMin: 5 },
        },
      },
    );
    expect(screen.getByText(/The kernel no longer exists/)).toBeInTheDocument();
    expect(screen.getByText(/A new kernel starts empty/)).toBeInTheDocument();
    expect(runOf('c1')).toBeDisabled();
    expect(socket.frames('execute')).toHaveLength(0);
    expect(posts).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Start a new kernel' }));
    await waitFor(() => expect(posts[0]?.url).toContain('/kernel'));
  });

  it('A32 Stop session asks for confirmation and Disconnect does not claim the kernel stopped', async () => {
    attach();
    fireEvent.click(screen.getByRole('button', { name: 'Session' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    expect(screen.getByLabelText('Stop session', { selector: 'section' })).toHaveTextContent(
      'the variables are lost',
    );
    expect(posts).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(posts).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Session' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    const confirm = screen.getByLabelText('Stop session', { selector: 'section' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Stop session' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      url: expect.stringContaining('/close'),
      body: { stop: true },
    });
  });

  it('A32 Disconnect leaves the kernel alone and says Parallax does not know whether it runs', async () => {
    const { socket } = attach();
    fireEvent.click(screen.getByRole('button', { name: 'Session' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    // It asks first, and nothing is sent until it is confirmed.
    const confirm = screen.getByLabelText('Disconnect', { selector: 'section' });
    expect(confirm).toHaveTextContent('does not stop it');
    expect(posts).toHaveLength(0);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(posts[0]).toMatchObject({ body: { stop: false } }));
    const note = await screen.findByText(/You disconnected from this session/);
    const banner = note.closest('div') as HTMLElement;
    expect(banner).toHaveTextContent('Parallax did not stop the kernel');
    expect(banner).toHaveTextContent('does not know whether it is still running');
    expect(banner).not.toHaveTextContent(/kernel (was|is) stopped/i);
    expect(runOf('c1')).toBeDisabled();
    expect(socket.frames('execute')).toHaveLength(0);
  });

  it('A32 a session Parallax did not start offers Disconnect and no Stop', () => {
    attach(
      { owned: false },
      {
        session: {
          state: 'ready',
          cause: null,
          owned: false,
          lease: { idleTimeoutMin: 30, gracePeriodMin: 5 },
        },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Session' }));
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop session' })).not.toBeInTheDocument();
  });

  it('A36 connection lost disables Run and keeps editing', () => {
    vi.useFakeTimers();
    const { socket } = attach();
    const editor = cellSection('c1').querySelector('.cm-content') as HTMLElement;
    const view = EditorView.findFromDOM(editor.closest('.cm-editor') as HTMLElement) as EditorView;
    act(() => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'y = 2' } });
    });
    socket.drop();
    expect(runOf('c1')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Run all' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('The connection to this session was lost');
    expect(screen.getByRole('alert')).toHaveTextContent('Your edits are kept');
    // The last kernel state is shown as unconfirmed, never as Ready.
    expect(screen.getByTestId('mode')).toHaveTextContent('Unconfirmed');
    expect(screen.getByTestId('mode')).not.toHaveTextContent('Ready');
    // Editing continues and the earlier edit is still there.
    expect(editor).toHaveAttribute('contenteditable', 'true');
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\nz = 3' } });
    });
    expect(view.state.doc.toString()).toBe('y = 2\nz = 3');
  });

  it('A36 a session that was lost shows its cause, keeps the notebook editable and offers Forget', async () => {
    const { socket, onOpenConnect } = attach();
    socket.receive({ t: 'session_state', state: 'disconnected', cause: 'sleep' });
    // The REST copy still says ready; the channel's word is enough to stop running cells.
    expect(runOf('c1')).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('This computer was asleep');
    expect(screen.getByRole('alert')).toHaveTextContent('Your edits to the notebook are kept');
    expect(screen.getByTestId('mode')).toHaveTextContent('Disconnected');
    fireEvent.click(screen.getByRole('button', { name: 'Forget this session' }));
    await waitFor(() => expect(posts[0]?.url).toContain('/forget'));
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(onOpenConnect).toHaveBeenCalled();
  });

  it('A36 a browser that is offline is the same connection-lost mode', () => {
    attach();
    expect(runOf('c1')).toBeEnabled();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(runOf('c1')).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('This browser is offline');
  });

  it('A36 an unconfirmed session never shows Ready', () => {
    const { socket } = attach();
    socket.receive({ t: 'session_state', state: 'unconfirmed', cause: 'link_lost' });
    expect(screen.getByTestId('mode')).toHaveTextContent('Unconfirmed');
    expect(screen.getByTestId('mode')).not.toHaveTextContent('Ready');
    expect(screen.getByRole('alert')).toHaveTextContent('Parallax cannot confirm this session');
  });

  it('Interrupt that does not stop the kernel offers Restart with a warning', () => {
    vi.useFakeTimers();
    const { socket } = attach(
      {},
      { kernel: { id: KERNEL, name: 'python3', state: 'busy', generation: 0 } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }));
    expect(socket.frames('interrupt')).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(4900);
    });
    expect(screen.queryByText(/did not stop after Interrupt/)).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByText(/did not stop after Interrupt/)).toHaveTextContent(
      'its variables will be lost',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Restart kernel' }));
    expect(screen.getByLabelText('Restart kernel', { selector: 'section' })).toHaveTextContent(
      'Its variables will be lost',
    );
    expect(posts).toHaveLength(0);
  });

  it('an interrupt that returns the kernel to idle offers no restart', () => {
    vi.useFakeTimers();
    const { socket } = attach(
      {},
      { kernel: { id: KERNEL, name: 'python3', state: 'busy', generation: 0 } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }));
    socket.receive({ t: 'kernel_state', state: 'idle', generation: 0 });
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.queryByText(/did not stop after Interrupt/)).not.toBeInTheDocument();
  });

  const answerOk = (socket: FakeSocket, cellId: string) => {
    fireEvent.click(runOf(cellId));
    const [sent] = socket.frames('execute');
    socket.receive({
      t: 'execution',
      executionId: exec(1),
      ref: sent?.ref,
      cellId,
      seq: 1,
      state: 'ok',
      outputsIncomplete: false,
      generation: 0,
    });
  };
  const richOutput = (socket: FakeSocket, eventSeq: number, data: Record<string, unknown>) =>
    socket.receive({
      t: 'output',
      executionId: exec(1),
      eventSeq,
      generation: 0,
      kind: 'output',
      output: { output_type: 'display_data', metadata: {}, data },
    });

  it('A09 live HTML output stays in the sandbox: it is never put on the app origin', () => {
    const { socket } = attach();
    answerOk(socket, 'c1');
    richOutput(socket, 1, {
      'text/html':
        '<table><tr><td>x online = 3</td></tr></table><img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script><iframe src="https://example.com"></iframe>',
      'text/plain': 'one row',
    });
    const section = cellSection('c1');
    // No markup of the output reaches the page, no frame is made, and nothing ran.
    expect(section.querySelector('iframe, script, img, table')).toBeNull();
    expect(section.innerHTML).not.toContain('onerror');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    // The plain alternative is shown, and the cell says what is not shown, truthfully.
    expect(section).toHaveTextContent('one row');
    expect(section).toHaveTextContent(
      'Rich output (text/html) is not shown in a live notebook yet',
    );
    expect(section).not.toHaveTextContent('Scripts in this output were removed');
  });

  it('A09 live images and SVG are named, not rendered, and an unknown type is never run', () => {
    const { socket } = attach();
    answerOk(socket, 'c1');
    richOutput(socket, 1, { 'image/png': 'iVBORw0KGgo=', 'text/plain': '<Figure size 640x480>' });
    richOutput(socket, 2, { 'image/svg+xml': '<svg onload="window.__pwned=1"></svg>' });
    richOutput(socket, 3, { 'application/vnd.jupyter.widget-view+json': { model_id: 'x' } });
    richOutput(socket, 4, { 'text/plain': '4' });
    const section = cellSection('c1');
    expect(section.querySelector('img, svg, iframe, script')).toBeNull();
    expect(section).toHaveTextContent('<Figure size 640x480>');
    expect(section).toHaveTextContent('Rich output (image/png) is not shown');
    expect(section).toHaveTextContent('Rich output (image/svg+xml) is not shown');
    expect(section).toHaveTextContent('Rich output (application/vnd.jupyter.widget-view+json)');
    expect(section).toHaveTextContent('4');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('keyboard runs and Run again are locked while Run all is going', () => {
    const { socket } = attach();
    fireEvent.click(screen.getByRole('button', { name: 'Run all' }));
    const before = socket.frames('execute').length;
    const content = cellSection('c3').querySelector('.cm-content') as HTMLElement;
    fireEvent.keyDown(content, { key: 'Enter', shiftKey: true });
    expect(socket.frames('execute')).toHaveLength(before);
  });

  it('A31 a socket replaced while closing does not clear the live one', () => {
    vi.useFakeTimers();
    const { socket } = attach();
    // The effect runs again (a session change or an offline/online toggle) before the old
    // socket's close event arrives.
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    const next = last();
    expect(next).not.toBe(socket);
    next.open();
    next.receive(ready());
    // Only now does the old socket's close arrive.
    socket.drop();
    fireEvent.click(runOf('c1'));
    expect(next.frames('execute')).toHaveLength(1);
  });

  it('Run all stops on an error', () => {
    const { socket } = attach();
    fireEvent.click(screen.getByRole('button', { name: 'Run all' }));
    const answer = (cellId: string, n: number, state: string) => {
      const sent = socket.frames('execute').find((m) => m.cellId === cellId);
      socket.receive({
        t: 'execution',
        executionId: exec(n),
        ref: sent?.ref,
        cellId,
        seq: n,
        state,
        outputsIncomplete: false,
        generation: 0,
      });
    };
    expect(socket.frames('execute').map((m) => m.cellId)).toEqual(['c1']);
    answer('c1', 1, 'running');
    answer('c1', 1, 'ok');
    expect(socket.frames('execute').map((m) => m.cellId)).toEqual(['c1', 'c2']);
    answer('c2', 2, 'running');
    answer('c2', 2, 'error');
    // The third cell was never sent, and the notebook says where it stopped.
    expect(socket.frames('execute').map((m) => m.cellId)).toEqual(['c1', 'c2']);
    expect(
      screen.getByText(/Run all stopped at cell 3 \[ \]: it ended with an error/),
    ).toBeInTheDocument();
  });

  it('Run all runs every code cell in notebook order', () => {
    const { socket } = attach();
    fireEvent.click(screen.getByRole('button', { name: 'Run all' }));
    for (const [i, id] of ['c1', 'c2', 'c3'].entries()) {
      const sent = socket.frames('execute').find((m) => m.cellId === id);
      expect(sent).toBeDefined();
      socket.receive({
        t: 'execution',
        executionId: exec(i + 1),
        ref: sent?.ref,
        cellId: id,
        seq: i + 1,
        state: 'ok',
        outputsIncomplete: false,
        generation: 0,
      });
    }
    expect(socket.frames('execute').map((m) => m.cellId)).toEqual(['c1', 'c2', 'c3']);
    expect(screen.getByRole('button', { name: 'Run all' })).toBeEnabled();
  });

  it('an input prompt belongs to its cell and its answer names that execution', () => {
    const { socket } = attach();
    fireEvent.click(runOf('c3'));
    const [sent] = socket.frames('execute');
    socket.receive({
      t: 'execution',
      executionId: exec(3),
      ref: sent?.ref,
      cellId: 'c3',
      seq: 1,
      state: 'running',
      outputsIncomplete: false,
      generation: 0,
    });
    socket.receive({ t: 'kernel_state', state: 'waiting_for_input', generation: 0 });
    socket.receive({
      t: 'output',
      executionId: exec(3),
      eventSeq: 1,
      generation: 0,
      kind: 'input_request',
      input: { prompt: 'Your name? ', password: false },
    });
    expect(within(cellSection('c3')).getByLabelText('Your name?')).toBeInTheDocument();
    expect(within(cellSection('c1')).queryByLabelText('Your name?')).not.toBeInTheDocument();
    fireEvent.change(within(cellSection('c3')).getByLabelText('Your name?'), {
      target: { value: 'Sam' },
    });
    fireEvent.click(within(cellSection('c3')).getByRole('button', { name: 'Send' }));
    expect(socket.frames('input_reply')[0]).toMatchObject({ executionId: exec(3), value: 'Sam' });
    expect(within(cellSection('c3')).queryByLabelText('Your name?')).not.toBeInTheDocument();
  });

  it('restart marks old outputs as from the previous kernel session', () => {
    const { socket } = attach();
    fireEvent.click(runOf('c1'));
    const [sent] = socket.frames('execute');
    socket.receive({
      t: 'execution',
      executionId: exec(1),
      ref: sent?.ref,
      cellId: 'c1',
      seq: 1,
      state: 'ok',
      outputsIncomplete: false,
      generation: 0,
    });
    socket.receive({
      t: 'output',
      executionId: exec(1),
      eventSeq: 1,
      generation: 0,
      kind: 'output',
      output: { output_type: 'stream', name: 'stdout', text: 'before\n' },
    });
    expect(cellSection('c1')).not.toHaveTextContent('previous kernel session');
    socket.receive({ t: 'kernel_state', state: 'restarting', generation: 1 });
    socket.receive({ t: 'kernel_state', state: 'idle', generation: 1 });
    expect(cellSection('c1')).toHaveTextContent('From a previous kernel session');
    expect(cellSection('c1')).toHaveTextContent('before');
  });

  it('truncated output carries a label', () => {
    const { socket } = attach();
    fireEvent.click(runOf('c1'));
    const [sent] = socket.frames('execute');
    socket.receive({
      t: 'execution',
      executionId: exec(1),
      ref: sent?.ref,
      cellId: 'c1',
      seq: 1,
      state: 'running',
      outputsIncomplete: false,
      generation: 0,
    });
    socket.receive({
      t: 'output',
      executionId: exec(1),
      eventSeq: 1,
      generation: 0,
      kind: 'output',
      truncated: true,
      output: { output_type: 'stream', name: 'stdout', text: 'tail\n' },
    });
    expect(cellSection('c1')).toHaveTextContent('Output truncated');
  });

  it('a relay that was restarted marks what was running as incomplete', () => {
    vi.useFakeTimers();
    const { socket } = attach();
    fireEvent.click(runOf('c1'));
    const [sent] = socket.frames('execute');
    socket.receive({
      t: 'execution',
      executionId: exec(1),
      ref: sent?.ref,
      cellId: 'c1',
      seq: 1,
      state: 'running',
      outputsIncomplete: false,
      generation: 0,
    });
    socket.drop();
    act(() => {
      vi.advanceTimersByTime(600);
    });
    const next = last();
    next.open();
    // Another epoch: the old position is dropped, the old run is not claimed complete.
    expect(next.frames('hello')[0]).toMatchObject({ resume: { epoch: EPOCH } });
    next.receive(ready({ epoch: '00000000-0000-4000-8000-0000000f0009' }));
    expect(cellSection('c1')).toHaveTextContent('some output or the result');
    expect(next.frames('execute')).toHaveLength(0);
  });

  it('keyboard: Run is reachable by Tab and runs the cell with Enter', () => {
    const { socket } = attach();
    const run = runOf('c2');
    run.focus();
    expect(run).toHaveFocus();
    fireEvent.click(run);
    expect(socket.frames('execute')[0]).toMatchObject({ cellId: 'c2' });
  });

  it('keyboard: Shift+Enter in a cell runs it', () => {
    const { socket } = attach();
    const content = cellSection('c3').querySelector('.cm-content') as HTMLElement;
    fireEvent.keyDown(content, { key: 'Enter', shiftKey: true });
    expect(socket.frames('execute')[0]).toMatchObject({ cellId: 'c3', code: 'print(3)' });
  });

  it('the live notebook has no accessibility violations', async () => {
    attach();
    const result = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(
      result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
    ).toEqual([]);
  });
});

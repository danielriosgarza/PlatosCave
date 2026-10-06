import { EditorView } from '@codemirror/view';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../session/revocation';
import { CLASS_A, stubApi } from '../../test/render';
import type { NotebookSession } from '../connect/api';
import { REVISION, session } from '../connect/fixtures';
import type { Notebook } from '../notebooks';
import { LiveNotebook } from './LiveNotebook';

const EPOCH = '00000000-0000-4000-8000-0000000f0001';
const KERNEL = '00000000-0000-4000-8000-0000000f0002';
const COPY = '00000000-0000-4000-8000-0000000000aa';
const NOW = '2026-10-05T10:00:00.000Z';
const WORKSPACE = '/home/sam/parallax';

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
}
const last = () => FakeSocket.all[FakeSocket.all.length - 1] as FakeSocket;

const readyMessage = {
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
};

const notebook: Notebook = {
  kernel: 'Python 3',
  language: 'python',
  outline: [],
  cells: [
    {
      id: 'c1',
      type: 'code',
      source: 'x = 1',
      executionCount: null,
      sourceHidden: false,
      outputsHidden: false,
      outputs: [],
    },
  ],
};

const revision = {
  revision: 2,
  sha256: 'a'.repeat(64),
  size: 120,
  source: 'browser',
  savedAt: NOW,
};
const stored = {
  id: COPY,
  sourceRevisionId: REVISION,
  currentRevision: 2,
  revision,
  notebook: {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [{ id: 'c1', cell_type: 'code', source: 'x = 1', metadata: {}, outputs: [] }],
  },
  revisions: [revision],
};
const listing = (declared: unknown[]) => ({
  workspace: WORKSPACE,
  host: null,
  dir: '',
  entries: [],
  declared,
});
const declaredFile = { path: 'data/sample.csv', size: 2048, sha256: 'c'.repeat(64) };
const copyInTransfer = {
  id: '00000000-0000-4000-8000-0000000000d1',
  sessionId: '00000000-0000-4000-8000-0000000d0001',
  direction: 'in',
  kind: 'copy_in',
  path: 'data/sample.csv',
  sha256: 'c'.repeat(64),
  size: 2048,
  state: 'done',
  outcome: 'copied',
  remote: null,
  error: null,
  revision: null,
  createdAt: NOW,
  finishedAt: NOW,
};

function Host({ over }: { over: Partial<NotebookSession> }): ReactNode {
  const [sources, setSources] = useState<Record<string, string>>({});
  return (
    <LiveNotebook
      classId={CLASS_A}
      session={session(over)}
      connectionName="Lab workstation"
      notebook={notebook}
      outlineOpen={false}
      showCode
      showOutputs
      sources={sources}
      onEdit={(id, value) => setSources((all) => ({ ...all, [id]: value }))}
      lead={(label) => <span data-testid="mode">{label}</span>}
      trail={null}
      onOpenConnect={() => {}}
    />
  );
}

function mount(declared: unknown[], over: Partial<NotebookSession> = {}) {
  const fetchMock = stubApi((url, init) => {
    if (init?.method === 'POST') return { status: 200, body: { transfers: [copyInTransfer] } };
    if (url.includes('/notebook-working-copies/')) return { status: 200, body: stored };
    if (url.includes('/transfers')) return { status: 200, body: { transfers: [] } };
    if (url.includes('/files')) return { status: 200, body: listing(declared) };
    return { status: 404, body: {} };
  });
  render(
    <QueryClientProvider client={createQueryClient({ retry: false })}>
      <Host over={over} />
    </QueryClientProvider>,
  );
  return fetchMock;
}

const attach = () => {
  last().open();
  last().receive(readyMessage);
};
const runButton = () => screen.getByRole('button', { name: /Run cell/ });

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('files, save and submit in the live notebook', () => {
  it('A34 the panels appear only for a ready session', async () => {
    mount([]);
    attach();
    expect(await screen.findByRole('heading', { name: 'Files' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Save' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Submit notebook' })).toBeInTheDocument();
    cleanup();

    const fetchMock = mount([], { state: 'disconnected', cause: 'sleep' });
    await act(async () => {});
    expect(screen.queryByRole('heading', { name: 'Files' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Submit notebook' })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('A34 Run is not offered until the declared files are copied in', async () => {
    mount([declaredFile]);
    attach();
    const copyIn = await screen.findByRole('button', {
      name: `Copy 1 file to ${WORKSPACE}`,
    });
    expect(runButton()).toBeDisabled();
    expect(screen.getByText(/declares 1 file that is not on the computer yet/)).toBeInTheDocument();
    await userEvent.setup().click(copyIn);
    await waitFor(() => expect(runButton()).toBeEnabled());
    expect(screen.queryByText(/declares 1 file/)).not.toBeInTheDocument();
  });

  it('A34 Run is offered once the person chooses to run without the files', async () => {
    mount([declaredFile]);
    attach();
    await screen.findByRole('button', { name: `Copy 1 file to ${WORKSPACE}` });
    expect(runButton()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Run without the files' }));
    expect(runButton()).toBeEnabled();
  });

  it('A34 Run is offered at once when the notebook declares no files', async () => {
    mount([]);
    attach();
    await screen.findByRole('heading', { name: 'Files' });
    expect(runButton()).toBeEnabled();
  });

  it('A34 Save to Parallax sends the code as it is in the editor', async () => {
    const fetchMock = mount([]);
    attach();
    await screen.findByRole('heading', { name: 'Save' });
    const editor = document.querySelector('[data-cell-id="c1"] .cm-content') as HTMLElement;
    const cm = EditorView.findFromDOM(editor.closest('.cm-editor') as HTMLElement) as EditorView;
    act(() => cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: 'y = 2' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Save to Parallax' }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([url, init]) => String(url).includes('/revisions') && init?.method === 'PUT',
      );
      expect(post).toBeDefined();
      const body = JSON.parse(String(post?.[1]?.body));
      expect(body).toMatchObject({
        baseRevision: 2,
        notebook: { cells: [{ id: 'c1', source: 'y = 2' }] },
      });
    });
  });
});

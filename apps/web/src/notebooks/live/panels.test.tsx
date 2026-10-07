import { EditorView } from '@codemirror/view';
import { focusManager, QueryClientProvider } from '@tanstack/react-query';
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

function Host({
  over,
  book = notebook,
}: {
  over: Partial<NotebookSession>;
  book?: Notebook;
}): ReactNode {
  const [sources, setSources] = useState<Record<string, string>>({});
  return (
    <LiveNotebook
      classId={CLASS_A}
      session={session(over)}
      connectionName="Lab workstation"
      notebook={book}
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

function mount(
  declared: unknown[],
  over: Partial<NotebookSession> = {},
  opts: { copy?: unknown; listing?: 'fail' | 'slow'; book?: Notebook } = {},
  release: { listing?: () => void } = {},
) {
  const fetchMock = stubApi((url, init) => {
    if (init?.method === 'POST') return { status: 200, body: { transfers: [copyInTransfer] } };
    if (url.includes('/notebook-working-copies/'))
      return { status: 200, body: opts.copy ?? stored };
    if (url.includes('/transfers')) return { status: 200, body: { transfers: [] } };
    if (url.includes('/files')) {
      return opts.listing === 'fail'
        ? { status: 409, body: { error: 'workspace_unknown' } }
        : { status: 200, body: listing(declared) };
    }
    return { status: 404, body: {} };
  });
  if (opts.listing === 'slow') {
    // The listing answers only when the test releases it.
    const answer = fetchMock.getMockImplementation() as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    fetchMock.mockImplementation((input, init) =>
      String(input).includes('/files')
        ? new Promise((resolve) => {
            release.listing = () => resolve(answer(input, init));
          })
        : answer(input, init),
    );
  }
  render(
    <QueryClientProvider client={createQueryClient({ retry: false })}>
      <Host over={over} book={opts.book} />
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
    expect(screen.getByText(/declares 1 file\./)).toBeInTheDocument();
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

  it('A34 a save equals what the editor shows when the stored copy differs from the course code', async () => {
    const differing = {
      ...stored,
      notebook: {
        ...stored.notebook,
        cells: [{ id: 'c1', cell_type: 'code', source: 'x = 99', metadata: {}, outputs: [] }],
      },
    };
    const fetchMock = mount([], {}, { copy: differing });
    attach();
    await screen.findByRole('heading', { name: 'Save' });
    await waitFor(() =>
      expect(document.querySelector('[data-cell-id="c1"] .cm-content')).toHaveTextContent('x = 99'),
    );
    expect(screen.queryByText(/changes that are not saved yet/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save to Parallax' }));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(JSON.parse(String(put?.[1]?.body))).toMatchObject({
        notebook: { cells: [{ id: 'c1', source: 'x = 99' }] },
      });
    });
  });

  it('A34 Save to Parallax is offered when the workspace cannot be read', async () => {
    mount([], {}, { listing: 'fail' });
    attach();
    expect(await screen.findByRole('button', { name: 'Save to Parallax' })).toBeEnabled();
    expect(screen.getByText(/saving to the computer is unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save to computer' })).not.toBeInTheDocument();
  });

  it('A34 edits to cells without nbformat ids are saved', async () => {
    const idless = {
      ...stored,
      notebook: {
        ...stored.notebook,
        cells: [{ cell_type: 'code', source: 'x = 1', metadata: {}, outputs: [] }],
      },
    };
    const fetchMock = mount([], {}, { copy: idless });
    attach();
    await screen.findByRole('heading', { name: 'Save' });
    const editor = document.querySelector('[data-cell-id="c1"] .cm-content') as HTMLElement;
    const cm = EditorView.findFromDOM(editor.closest('.cm-editor') as HTMLElement) as EditorView;
    act(() => cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: 'y = 2' } }));
    await screen.findByText(/changes that are not saved yet/);
    fireEvent.click(screen.getByRole('button', { name: 'Save to Parallax' }));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(JSON.parse(String(put?.[1]?.body))).toMatchObject({
        baseRevision: 2,
        notebook: { cells: [{ source: 'y = 2' }] },
      });
    });
  });

  it('A34 an Import conflict keeps the edited code, offers no plain Save, and the chosen save is based on the newer copy', async () => {
    const newer = {
      ...stored,
      currentRevision: 5,
      revision: { ...revision, revision: 5 },
      notebook: {
        ...stored.notebook,
        cells: [{ id: 'c1', cell_type: 'code', source: 'z = 5', metadata: {}, outputs: [] }],
      },
    };
    const fetchMock = stubApi((url, init) => {
      if (init?.method === 'POST')
        return { status: 409, body: { error: 'revision_conflict', current: newer } };
      if (init?.method === 'PUT') return { status: 200, body: { ...newer, currentRevision: 6 } };
      if (url.includes('/notebook-working-copies/')) return { status: 200, body: stored };
      if (url.includes('/transfers')) return { status: 200, body: { transfers: [] } };
      if (url.includes('/files'))
        return {
          status: 200,
          body: {
            ...listing([]),
            entries: [
              { path: 'e.ipynb', name: 'e.ipynb', type: 'notebook', size: 9, modified: NOW },
            ],
          },
        };
      return { status: 404, body: {} };
    });
    render(
      <QueryClientProvider client={createQueryClient({ retry: false })}>
        <Host over={{}} />
      </QueryClientProvider>,
    );
    attach();
    await screen.findByRole('heading', { name: 'Save' });
    const editor = document.querySelector('[data-cell-id="c1"] .cm-content') as HTMLElement;
    const cm = EditorView.findFromDOM(editor.closest('.cm-editor') as HTMLElement) as EditorView;
    act(() => cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: 'y = 2' } }));
    fireEvent.click(await screen.findByRole('button', { name: 'Import e.ipynb' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import as revision 3' }));
    expect(await screen.findByText(/now at revision 5/)).toBeInTheDocument();
    // The edited code stays in the editor; the newer copy's code is not shown.
    expect(document.querySelector('[data-cell-id="c1"] .cm-content')).toHaveTextContent('y = 2');
    expect(document.querySelector('[data-cell-id="c1"] .cm-content')).not.toHaveTextContent(
      'z = 5',
    );
    // The newer copy is not overwritten by a plain Save: the person chooses to place the draft.
    expect(screen.queryByRole('button', { name: 'Save to Parallax' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Save my draft as revision 6' }));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(JSON.parse(String(put?.[1]?.body))).toMatchObject({
        baseRevision: 5,
        notebook: { cells: [{ id: 'c1', source: 'y = 2' }] },
      });
    });
  });

  it('A34 the working copy is not refetched behind the editor when the window regains focus', async () => {
    const fetchMock = mount([]);
    attach();
    await screen.findByRole('heading', { name: 'Save' });
    const reads = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/notebook-working-copies/'))
        .length;
    const before = reads();
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await act(async () => {});
    expect(reads()).toBe(before);
  });
});

const codeCell = (id: string, source: string): Notebook['cells'][number] => ({
  id,
  type: 'code',
  source,
  executionCount: null,
  sourceHidden: false,
  outputsHidden: false,
  outputs: [],
});
const storedCell = (id: string, source: string) => ({
  id,
  cell_type: 'code',
  source,
  metadata: {},
  outputs: [],
});
const edit = (id: string, text: string) => {
  const editor = document.querySelector(`[data-cell-id="${id}"] .cm-content`) as HTMLElement;
  const cm = EditorView.findFromDOM(editor.closest('.cm-editor') as HTMLElement) as EditorView;
  act(() => cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: text } }));
};

describe('pairing the editor cells with the stored copy', () => {
  it('A34 two live cells never share one stored cell: edits to both reach the save', async () => {
    const book: Notebook = { ...notebook, cells: [codeCell('a', 'a0'), codeCell('b', 'b0')] };
    const copy = {
      ...stored,
      notebook: { ...stored.notebook, cells: [storedCell('b', 'b1'), storedCell('x', 'x1')] },
    };
    const fetchMock = mount([], {}, { copy, book });
    attach();
    await screen.findByRole('heading', { name: 'Save' });
    await waitFor(() =>
      expect(document.querySelector('[data-cell-id="b"] .cm-content')).toHaveTextContent('b1'),
    );
    expect(document.querySelector('[data-cell-id="a"] .cm-content')).toHaveTextContent('a0');
    edit('a', 'a2');
    edit('b', 'b2');
    fireEvent.click(screen.getByRole('button', { name: 'Save to Parallax' }));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
      const cells = JSON.parse(String(put?.[1]?.body)).notebook.cells;
      expect(cells.map((c: { id: string; source: string }) => [c.id, c.source])).toEqual([
        ['b', 'b2'],
        ['x', 'x1'],
        ['a', 'a2'],
      ]);
    });
  });

  it('A34 an edit to a cell the stored copy lacks is saved and flagged as unsaved', async () => {
    const book: Notebook = { ...notebook, cells: [codeCell('c1', 'x = 1'), codeCell('c2', 'z')] };
    const fetchMock = mount([], {}, { book });
    attach();
    await screen.findByRole('heading', { name: 'Save' });
    expect(screen.queryByText(/changes that are not saved yet/)).not.toBeInTheDocument();
    edit('c2', 'z = 3');
    await screen.findByText(/changes that are not saved yet/);
    fireEvent.click(screen.getByRole('button', { name: 'Save to Parallax' }));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(JSON.parse(String(put?.[1]?.body)).notebook.cells).toMatchObject([
        { id: 'c1', source: 'x = 1' },
        { id: 'c2', source: 'z = 3' },
      ]);
    });
  });

  it('A34 Run is not offered while the declared files are still being read', async () => {
    const release: { listing?: () => void } = {};
    mount([declaredFile], {}, { listing: 'slow' }, release);
    attach();
    await waitFor(() => expect(release.listing).toBeDefined());
    expect(runButton()).toBeDisabled();
    expect(screen.getByText(/Reading the workspace to find any files/)).toBeInTheDocument();
    await act(async () => release.listing?.());
    await screen.findByText(/declares 1 file\./);
    expect(runButton()).toBeDisabled();
  });

  it('A34 a stored cell of another type holding a live cell id is never duplicated by a save', async () => {
    const book: Notebook = { ...notebook, cells: [codeCell('c1', 'x = 1'), codeCell('m', 'z')] };
    const copy = {
      ...stored,
      notebook: {
        ...stored.notebook,
        cells: [
          storedCell('c1', 'x = 1'),
          { id: 'm', cell_type: 'markdown', source: 'notes', metadata: {} },
        ],
      },
    };
    const fetchMock = mount([], {}, { copy, book });
    attach();
    await screen.findByRole('heading', { name: 'Save' });
    edit('m', 'z = 9');
    await screen.findByText(/are not saved: another cell of the stored copy has its id \(m\)/);
    fireEvent.click(screen.getByRole('button', { name: 'Save to Parallax' }));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
      const ids = JSON.parse(String(put?.[1]?.body)).notebook.cells.map(
        (c: { id: string }) => c.id,
      );
      expect(ids).toEqual(['c1', 'm']);
    });
  });
});

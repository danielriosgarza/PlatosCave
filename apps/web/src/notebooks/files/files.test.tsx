import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../session/revocation';
import { CLASS_A, stubApi } from '../../test/render';
import { ColabSubmission } from '../ColabSubmission';
import { FilesPanel } from './FilesPanel';
import { SaveControls } from './SaveControls';
import { snapshotEnvironment } from './SnapshotView';
import { SubmitPanel } from './SubmitPanel';

const SESSION = '00000000-0000-4000-8000-0000000000cc';
const COPY = '00000000-0000-4000-8000-0000000000aa';
const REV = '00000000-0000-4000-8000-000000000701';
const RES = '00000000-0000-4000-8000-000000000401';
const T1 = '00000000-0000-4000-8000-0000000000d1';
const T2 = '00000000-0000-4000-8000-0000000000d2';
const T3 = '00000000-0000-4000-8000-0000000000d3';
const SUB = '00000000-0000-4000-8000-0000000000ee';
const FILE = '00000000-0000-4000-8000-0000000000f1';
const WORKSPACE = '/home/sam/parallax/week-3';
const NOW = '2026-10-05T10:00:00.000Z';

const notebook: Record<string, unknown> = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [],
};
const revision = {
  revision: 2,
  sha256: 'a'.repeat(64),
  size: 120,
  source: 'browser',
  savedAt: NOW,
};
const copy = (over: Record<string, unknown> = {}) => ({
  id: COPY,
  sourceRevisionId: REV,
  currentRevision: 2,
  revision,
  notebook,
  revisions: [revision],
  ...over,
});

const transfer = (over: Record<string, unknown> = {}) => ({
  id: T1,
  sessionId: SESSION,
  direction: 'out',
  kind: 'copy_out',
  path: 'results.csv',
  sha256: 'b'.repeat(64),
  size: 2048,
  state: 'done',
  outcome: 'copied',
  remote: null,
  error: null,
  revision: null,
  createdAt: NOW,
  finishedAt: NOW,
  ...over,
});

const wrap = (node: ReactNode) => (
  <QueryClientProvider client={createQueryClient({ retry: false })}>{node}</QueryClientProvider>
);

const json = (init?: RequestInit) => JSON.parse(String(init?.body ?? 'null'));
const posts = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSave(getNotebook = () => notebook) {
  const onWorkingCopy = vi.fn();
  render(
    wrap(
      <SaveControls
        classId={CLASS_A}
        sessionId={SESSION}
        workingCopy={copy() as never}
        getNotebook={getNotebook}
        onWorkingCopy={onWorkingCopy}
        workspace={WORKSPACE}
        host="hpc.example.edu"
      />,
    ),
  );
  return { onWorkingCopy };
}

describe('save controls', () => {
  it('A34 Saved to Parallax appears only after the acknowledgement', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await gate;
        return new Response(
          JSON.stringify(copy({ currentRevision: 3, revision: { ...revision, revision: 3 } })),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }),
    );
    const { onWorkingCopy } = renderSave();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save to Parallax' }));
    // The request is in flight: nothing says saved.
    expect(screen.getByRole('button', { name: 'Saving' })).toBeDisabled();
    expect(screen.queryByText(/saved to parallax as/i)).toBeNull();
    release?.();
    expect(await screen.findByRole('status')).toHaveTextContent(/saved to parallax as revision 3/i);
    expect(onWorkingCopy).toHaveBeenCalledOnce();
  });

  it('A34 Save to computer names the exact destination and says Saved only after the transfer is done', async () => {
    const fetchMock = stubApi((_, init) =>
      init?.method === 'POST'
        ? {
            status: 200,
            body: {
              transfers: [
                transfer({
                  direction: 'in',
                  kind: 'save',
                  path: 'notebook.ipynb',
                  outcome: 'copied',
                }),
              ],
            },
          }
        : { status: 404 },
    );
    renderSave();
    expect(screen.getByText(WORKSPACE)).toBeInTheDocument();
    expect(screen.getByText(/hpc\.example\.edu/)).toBeInTheDocument();
    expect(screen.queryByText(/saved to hpc/i)).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save to computer' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      `Saved to hpc.example.edu: notebook.ipynb in ${WORKSPACE}`,
    );
    expect(json(posts(fetchMock)[0]?.[1])).toEqual({
      kind: 'save',
      revision: 2,
      path: 'notebook.ipynb',
    });
  });

  it('A34 a failed or unfinished save to computer is never reported as Saved', async () => {
    let answer = transfer({
      direction: 'in',
      kind: 'save',
      path: 'notebook.ipynb',
      state: 'failed',
      outcome: null,
      error: 'copy_exists',
    });
    stubApi((_, init) =>
      init?.method === 'POST' ? { status: 200, body: { transfers: [answer] } } : { status: 404 },
    );
    renderSave();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save to computer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not saved to computer/i);
    expect(screen.queryByText(/saved to hpc/i)).toBeNull();
    answer = { ...answer, state: 'started', error: null as never };
    await user.click(screen.getByRole('button', { name: 'Save to computer' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/in progress/i));
    expect(screen.queryByText(/saved to hpc/i)).toBeNull();
  });

  it('A34 a conflict offers three choices and overwrites nothing', async () => {
    const fetchMock = stubApi((_, init) => {
      if (init?.method !== 'POST') return { status: 404 };
      const body = json(init);
      return body.choice
        ? {
            status: 200,
            body: {
              transfers: [
                transfer({
                  kind: 'save',
                  direction: 'in',
                  path: 'notebook (parallax).ipynb',
                  outcome: 'saved_copy',
                }),
              ],
            },
          }
        : {
            status: 200,
            body: {
              transfers: [
                transfer({
                  kind: 'save',
                  direction: 'in',
                  path: 'notebook.ipynb',
                  state: 'conflict',
                  outcome: null,
                  remote: { sha256: 'c'.repeat(64), size: 999 },
                }),
              ],
            },
          };
    });
    renderSave();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save to computer' }));
    const dialog = await screen.findByRole('dialog', { name: /notebook\.ipynb already exists/i });
    expect(within(dialog).getByRole('button', { name: 'Keep theirs' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Replace with mine' })).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: 'Save mine as notebook (parallax).ipynb' }),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent('Nothing has been written');
    // Until a choice is made, exactly one request went out and it carried no choice.
    expect(posts(fetchMock)).toHaveLength(1);
    expect(json(posts(fetchMock)[0]?.[1]).choice).toBeUndefined();
    expect(screen.queryByText(/^saved to/i)).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: /Save mine as/ }));
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(2));
    expect(json(posts(fetchMock)[1]?.[1]).choice).toBe('save_copy');
    expect(await screen.findByRole('status')).toHaveTextContent('notebook (parallax).ipynb');
  });

  it('A34 Escape leaves the existing file alone and focus returns to the button', async () => {
    const fetchMock = stubApi((_, init) =>
      init?.method === 'POST'
        ? {
            status: 200,
            body: {
              transfers: [
                transfer({
                  kind: 'save',
                  direction: 'in',
                  path: 'notebook.ipynb',
                  state: 'conflict',
                  outcome: null,
                  remote: { sha256: '', size: 5 },
                }),
              ],
            },
          }
        : { status: 404 },
    );
    renderSave();
    const user = userEvent.setup();
    const button = screen.getByRole('button', { name: 'Save to computer' });
    await user.click(button);
    await screen.findByRole('dialog');
    // The keyboard path: focus is inside, Tab stays inside, Escape closes.
    expect(screen.getByRole('button', { name: 'Keep theirs' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Replace with mine' })).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(button).toHaveFocus();
    expect(screen.getByRole('alert')).toHaveTextContent(/left as it is/i);
    expect(posts(fetchMock)).toHaveLength(1);
  });

  it('A34 a failed save keeps the draft and offers Retry and a download', async () => {
    const draft = { ...notebook, cells: [{ cell_type: 'code', source: 'x = 1' }] };
    let failing = true;
    const fetchMock = stubApi(() =>
      failing
        ? { status: 500, body: {} }
        : {
            status: 200,
            body: copy({ currentRevision: 3, revision: { ...revision, revision: 3 } }),
          },
    );
    const createObjectURL = vi.fn(() => 'blob:draft');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    renderSave(() => draft);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save to Parallax' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/not saved to parallax/i);
    expect(alert).toHaveTextContent(/draft is still in this page/i);
    expect(screen.queryByText(/saved to parallax as/i)).toBeNull();
    await user.click(within(alert).getByRole('button', { name: 'Download .ipynb' }));
    expect(createObjectURL).toHaveBeenCalledOnce();
    failing = false;
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/saved to parallax as revision 3/i);
    // Both attempts sent the same draft from the same base revision.
    const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(puts.map(([, init]) => json(init))).toEqual([
      { baseRevision: 2, notebook: draft },
      { baseRevision: 2, notebook: draft },
    ]);
  });

  it('A34 a stale save overwrites nothing and says which revision is current', async () => {
    stubApi(() => ({
      status: 409,
      body: { error: 'revision_conflict', current: copy({ currentRevision: 5 }) },
    }));
    renderSave();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save to Parallax' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/revision 5/);
    expect(
      within(alert).getByRole('button', { name: 'Save my draft as revision 6' }),
    ).toBeInTheDocument();
  });
});

describe('files panel', () => {
  const listing = {
    workspace: WORKSPACE,
    host: 'hpc.example.edu',
    dir: '',
    entries: [
      { path: 'out.csv', name: 'out.csv', type: 'file', size: 4096, modified: NOW },
      { path: 'huge.bin', name: 'huge.bin', type: 'file', size: 30 * 1024 * 1024, modified: NOW },
      { path: 'edited.ipynb', name: 'edited.ipynb', type: 'notebook', size: 900, modified: NOW },
    ],
    declared: [{ path: 'data/sample.csv', size: 2048, sha256: 'd'.repeat(64) }],
  };

  it('A34 copy-in asks for the exact destination and reports each file by its acknowledgement', async () => {
    const fetchMock = stubApi((url, init) => {
      if (init?.method === 'POST') {
        return {
          status: 200,
          body: {
            transfers: [
              transfer({ direction: 'in', kind: 'copy_in', path: 'data/sample.csv', size: 2048 }),
            ],
          },
        };
      }
      return url.includes('/files') ? { status: 200, body: listing } : { status: 404 };
    });
    render(
      wrap(
        <FilesPanel
          classId={CLASS_A}
          sessionId={SESSION}
          workingCopy={copy() as never}
          onWorkingCopy={vi.fn()}
        />,
      ),
    );
    const copyIn = await screen.findByRole('button', { name: `Copy 1 file to ${WORKSPACE}` });
    expect(screen.getByText(/data\/sample\.csv/)).toBeInTheDocument();
    expect(posts(fetchMock)).toHaveLength(0);
    await userEvent.setup().click(copyIn);
    expect(await screen.findByLabelText('Copy results')).toHaveTextContent(
      'data/sample.csv · Copied to hpc.example.edu',
    );
  });

  it('A34 only files inside the size limit can be selected, and sizes are shown', async () => {
    const fetchMock = stubApi((url, init) => {
      if (init?.method === 'POST') {
        return { status: 200, body: { transfers: [transfer({ path: 'out.csv', size: 4096 })] } };
      }
      return url.includes('/files')
        ? { status: 200, body: { ...listing, declared: [] } }
        : { status: 404 };
    });
    render(
      wrap(
        <FilesPanel
          classId={CLASS_A}
          sessionId={SESSION}
          workingCopy={copy() as never}
          onWorkingCopy={vi.fn()}
        />,
      ),
    );
    const user = userEvent.setup();
    const out = await screen.findByRole('checkbox', { name: 'Copy out.csv to Parallax' });
    expect(screen.getByRole('checkbox', { name: 'Copy huge.bin to Parallax' })).toBeDisabled();
    expect(screen.getByText(/over 25\.0 MB, cannot be copied/)).toBeInTheDocument();
    expect(screen.getByText(/stay on hpc\.example\.edu/)).toBeInTheDocument();
    await user.click(out);
    expect(screen.getByText('1 file selected · 4 KB')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy selected files to Parallax' }));
    expect(await screen.findByLabelText('Files copied to Parallax')).toHaveTextContent(
      'out.csv · 4 KB · Copied to Parallax',
    );
    expect(json(posts(fetchMock)[0]?.[1])).toEqual({ kind: 'copy_out', paths: ['out.csv'] });
  });

  it('A34 opening a folder keeps the selection and the copied list', async () => {
    const withDir = {
      ...listing,
      declared: [],
      entries: [
        ...listing.entries,
        { path: 'sub', name: 'sub', type: 'directory', size: null, modified: null },
      ],
    };
    stubApi((url, init) => {
      if (init?.method === 'POST') {
        return { status: 200, body: { transfers: [transfer({ path: 'out.csv', size: 4096 })] } };
      }
      if (!url.includes('/files')) return { status: 404 };
      return url.includes('dir=sub')
        ? {
            status: 200,
            body: {
              ...listing,
              declared: [],
              dir: 'sub',
              entries: [
                { path: 'sub/b.csv', name: 'b.csv', type: 'file', size: 10, modified: NOW },
              ],
            },
          }
        : { status: 200, body: withDir };
    });
    render(
      wrap(
        <FilesPanel
          classId={CLASS_A}
          sessionId={SESSION}
          workingCopy={copy() as never}
          onWorkingCopy={vi.fn()}
        />,
      ),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Copy out.csv to Parallax' }));
    await user.click(screen.getByRole('button', { name: 'sub/' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Copy b.csv to Parallax' }));
    // The selection from the first folder is still there.
    expect(screen.getByText('2 files selected · 4 KB')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy selected files to Parallax' }));
    expect(await screen.findByLabelText('Files copied to Parallax')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Up one folder' }));
    await screen.findByRole('checkbox', { name: 'Copy out.csv to Parallax' });
    expect(screen.getByLabelText('Files copied to Parallax')).toBeInTheDocument();
  });

  it('A34 Import asks before it creates a new revision', async () => {
    const imported = copy({
      currentRevision: 3,
      revision: { ...revision, revision: 3, source: 'import' },
    });
    const onWorkingCopy = vi.fn();
    const fetchMock = stubApi((url, init) =>
      init?.method === 'POST'
        ? { status: 200, body: { transfers: [], workingCopy: imported } }
        : url.includes('/files')
          ? { status: 200, body: { ...listing, declared: [] } }
          : { status: 404 },
    );
    render(
      wrap(
        <FilesPanel
          classId={CLASS_A}
          sessionId={SESSION}
          workingCopy={copy() as never}
          onWorkingCopy={onWorkingCopy}
        />,
      ),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Import edited.ipynb' }));
    expect(posts(fetchMock)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Import as revision 3' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      /imported edited\.ipynb as revision 3/i,
    );
    expect(onWorkingCopy).toHaveBeenCalledWith(imported);
    expect(json(posts(fetchMock)[0]?.[1])).toEqual({
      kind: 'import',
      path: 'edited.ipynb',
      baseRevision: 2,
    });
  });
});

describe('submit panel', () => {
  it('A34 only selected acknowledged files are listed for submission', async () => {
    const fetchMock = stubApi((url, init) => {
      if (init?.method === 'POST') {
        return {
          status: 200,
          body: {
            id: SUB,
            resourceId: RES,
            resourceRevisionId: REV,
            version: 1,
            filename: 'notebook.ipynb',
            size: 120,
            sha256: 'e'.repeat(64),
            environment: {},
            receivedAt: NOW,
            workingCopyRevision: 2,
            files: [{ id: FILE, path: 'results.csv', size: 2048, sha256: 'b'.repeat(64) }],
          },
        };
      }
      return url.includes('/transfers')
        ? {
            status: 200,
            body: {
              transfers: [
                transfer({ id: T1, path: 'results.csv' }),
                transfer({
                  id: T2,
                  path: 'half.csv',
                  state: 'started',
                  outcome: null,
                  finishedAt: null,
                }),
                transfer({
                  id: T3,
                  path: 'broken.csv',
                  state: 'failed',
                  outcome: null,
                  error: 'too_large',
                }),
              ],
            },
          }
        : { status: 404 };
    });
    render(
      wrap(
        <SubmitPanel
          classId={CLASS_A}
          sessionId={SESSION}
          workingCopy={copy() as never}
          environment={{ os: 'linux', arch: 'amd64', interpreter: 'Python 3.12.4' }}
        />,
      ),
    );
    const user = userEvent.setup();
    const frozen = await screen.findByRole('list', { name: 'What will be frozen' });
    expect(within(frozen).getByText(/Notebook: revision 2/)).toBeInTheDocument();
    expect(
      within(frozen).getByText(
        /linux · amd64 · Python 3\.12\.4 \(reported by the connected computer\)/,
      ),
    ).toBeInTheDocument();
    expect(within(frozen).getByText(/Files: none selected/)).toBeInTheDocument();
    // Only the file Parallax acknowledged can be chosen; started and failed ones are not offered.
    const choices = await screen.findAllByRole('checkbox');
    expect(choices.map((c) => c.parentElement?.textContent?.trim())).toEqual([
      'results.csv · 2 KB',
    ]);
    expect(screen.queryByText(/half\.csv/)).toBeNull();
    expect(screen.queryByText(/broken\.csv/)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Submit notebook' }));
    // Nothing selected, so nothing is frozen with it.
    await screen.findByRole('status');
    expect(json(posts(fetchMock)[0]?.[1])).toMatchObject({
      revision: 2,
      sessionId: SESSION,
      transferIds: [],
    });

    await user.click(await screen.findByRole('checkbox'));
    expect(within(frozen).getByText(/Files: results\.csv \(2 KB\)/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Submit notebook' }));
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(2));
    expect(json(posts(fetchMock)[1]?.[1]).transferIds).toEqual([T1]);
    // The two submissions are two attempts: distinct idempotency keys.
    expect(json(posts(fetchMock)[0]?.[1]).submissionKey).not.toEqual(
      json(posts(fetchMock)[1]?.[1]).submissionKey,
    );
  });

  it('A34 the receipt appears only with the server’s answer and a refusal shows none', async () => {
    let answer: { status: number; body: unknown } = {
      status: 400,
      body: { message: 'Transfer is not finished' },
    };
    stubApi((url, init) =>
      init?.method === 'POST'
        ? answer
        : url.includes('/transfers')
          ? { status: 200, body: { transfers: [] } }
          : { status: 404 },
    );
    render(
      wrap(
        <SubmitPanel
          classId={CLASS_A}
          sessionId={SESSION}
          workingCopy={copy() as never}
          environment={{}}
        />,
      ),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Submit notebook' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not submitted. Transfer is not finished',
    );
    expect(screen.queryByText(/received/i)).toBeNull();
    answer = {
      status: 200,
      body: {
        id: SUB,
        resourceId: RES,
        resourceRevisionId: REV,
        version: 2,
        filename: 'n.ipynb',
        size: 1,
        sha256: 'f'.repeat(64),
        environment: {},
        receivedAt: NOW,
        workingCopyRevision: 2,
        files: [],
      },
    };
    await user.click(screen.getByRole('button', { name: 'Submit notebook' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      /received .* version 2 · revision 2 · 0 files/i,
    );
  });
});

describe('instructor snapshot', () => {
  it('A35 the instructor view shows the snapshot and no connect action', async () => {
    const row = {
      id: SUB,
      resourceId: RES,
      resourceRevisionId: REV,
      version: 1,
      filename: 'notebook.ipynb',
      size: 4096,
      sha256: 'e'.repeat(64),
      environment: {
        runtime: 'connector',
        os: 'linux',
        arch: 'amd64',
        interpreter: 'Python 3.12.4',
        kernel: 'Python 3',
        language: 'python',
      },
      receivedAt: NOW,
      workingCopyRevision: 4,
      files: [{ id: FILE, path: 'results.csv', size: 9, sha256: 'b'.repeat(64) }],
      student: { id: '00000000-0000-4000-8000-000000000004', name: 'Sam Okafor' },
      removed: false,
    };
    const fetchMock = stubApi((url) =>
      url.endsWith('/notebook-submissions/mine')
        ? { status: 200, body: { submissions: [] } }
        : url.endsWith('/notebook-submissions')
          ? { status: 200, body: { submissions: [row] } }
          : { status: 404 },
    );
    render(wrap(<ColabSubmission classId={CLASS_A} resourceId={RES} instructor />));
    const snapshot = await screen.findByRole('region', { name: 'Snapshot of Sam Okafor' });
    expect(snapshot).toHaveTextContent('Notebook revision 4');
    expect(snapshot).toHaveTextContent(
      'Environment: linux · amd64 · Python 3.12.4 · Python 3 (reported by the connected computer)',
    );
    expect(within(snapshot).getByRole('row', { name: /results\.csv.*9 B/ })).toBeInTheDocument();
    expect(
      within(snapshot).getByRole('button', { name: 'Download results.csv' }),
    ).toBeInTheDocument();
    // No way to reach the student's computer from here, and nothing asked of it.
    expect(
      screen.queryByRole('button', { name: /connect|reconnect|run|open session/i }),
    ).toBeNull();
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).not.toMatch(/notebook-sessions|connections|connectors/);
    }
  });
});

describe('snapshot environment line', () => {
  it('A35 the reported interpreter is shown when the notebook declares no language', () => {
    expect(snapshotEnvironment({ os: 'linux', arch: 'amd64', interpreter: 'Python 3.12.4' })).toBe(
      'linux · amd64 · Python 3.12.4 (reported by the connected computer)',
    );
    expect(snapshotEnvironment({ language: 'python' })).toContain('python');
    expect(snapshotEnvironment({})).toBe('Not reported');
  });
});

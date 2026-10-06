import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../session/revocation';
import {
  CLASS_A,
  COURSE,
  makeMe,
  makeTopics,
  renderApp,
  stubApi,
  studentIn,
  T_SAMPLING,
} from '../../test/render';
import { ConnectPanel } from './ConnectPanel';
import {
  CONNECTION,
  CONNECTOR,
  connector,
  FP_A,
  FP_B,
  localConnection,
  ok,
  REVISION,
  SESSION,
  session,
  sshConnection,
  TEST_ID,
  testView,
} from './fixtures';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

interface World {
  connectors: unknown[];
  connections: unknown[];
  sessions: unknown[];
  session?: unknown;
  kernel: unknown;
  test: unknown;
  posts: { url: string; body: unknown }[];
  /** Answers the next test start with this refusal. */
  refuseTest?: { status: number; error: string };
  /** Answers close, forget and kernel start with this refusal. */
  refuse?: { status: number; error: string; code?: string };
  /** A second session, answered under its own id. */
  other?: { session: unknown; kernel: unknown };
}

/** An API for the panel with state a test can change between polls. */
function world(over: Partial<World> = {}): World {
  return {
    connectors: [connector()],
    connections: [],
    sessions: [],
    kernel: null,
    test: testView({ state: 'running' }),
    posts: [],
    ...over,
  };
}

function serve(w: World) {
  return stubApi((url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'POST')
      w.posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === '/api/me/connectors') return { status: 200, body: w.connectors };
    if (url === '/api/me/connections' && method === 'GET')
      return { status: 200, body: w.connections };
    if (url === '/api/me/connections' && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      return { status: 201, body: { ...localConnection(), ...body, id: CONNECTION } };
    }
    if (url === `/api/me/connections/${CONNECTION}` && method === 'PATCH') {
      return { status: 200, body: { ...sshConnection(), ...JSON.parse(String(init?.body)) } };
    }
    if (url === `/api/me/connections/${CONNECTION}/test` && w.refuseTest) {
      return { status: w.refuseTest.status, body: { error: w.refuseTest.error } };
    }
    if (url === `/api/me/connections/${CONNECTION}/test`)
      return { status: 202, body: { testId: TEST_ID } };
    if (url === `/api/me/connections/${CONNECTION}/tests/${TEST_ID}`)
      return { status: 200, body: w.test };
    if (url === `/api/classes/${CLASS_A}/notebook-sessions` && method === 'GET') {
      return { status: 200, body: w.sessions };
    }
    if (url === `/api/classes/${CLASS_A}/notebook-sessions` && method === 'POST') {
      return { status: 202, body: { sessionId: SESSION, state: 'starting' } };
    }
    if (url === `/api/classes/${CLASS_A}/notebook-sessions/${SESSION}`) {
      return w.session ? { status: 200, body: w.session } : { status: 404, body: {} };
    }
    if (w.other && url.startsWith(`/api/classes/${CLASS_A}/notebook-sessions/${SESSION_B}`)) {
      if (url.endsWith('/kernel')) {
        return { status: method === 'POST' ? 201 : 200, body: { kernel: w.other.kernel } };
      }
      return { status: 200, body: w.other.session };
    }
    if (
      w.refuse &&
      method === 'POST' &&
      url.startsWith(`/api/classes/${CLASS_A}/notebook-sessions/${SESSION}/`)
    ) {
      return {
        status: w.refuse.status,
        body: { error: w.refuse.error, ...(w.refuse.code ? { code: w.refuse.code } : {}) },
      };
    }
    if (url === `/api/classes/${CLASS_A}/notebook-sessions/${SESSION}/kernel`) {
      return method === 'POST'
        ? { status: 201, body: { kernel: w.kernel } }
        : { status: 200, body: { kernel: w.kernel } };
    }
    if (url === `/api/classes/${CLASS_A}/notebook-sessions/${SESSION}/kernel/restart`) {
      return { status: 200, body: { kernel: w.kernel } };
    }
    return { status: 404, body: {} };
  });
}

function renderPanel(onClose = vi.fn()) {
  const view = render(
    <QueryClientProvider client={createQueryClient({ retry: false })}>
      <ConnectPanel classId={CLASS_A} revisionId={REVISION} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { ...view, onClose };
}

const SESSION_B = '00000000-0000-4000-8000-0000000d0002';

const kernel = (state: string) => ({
  id: '00000000-0000-4000-8000-0000000e0001',
  name: 'python3',
  state,
  generation: 0,
});

const READY_TEST = testView({
  outcome: 'ready_to_start',
  jupyterVersion: '2.14.0',
  kernelspecs: [{ name: 'python3', displayName: 'Python 3', language: 'python' }],
  stages: [
    ok('workspace', { resolvedPath: '/home/sam/notebooks' }),
    ok('runtime'),
    { name: 'notebook_auth', status: 'skipped', data: { reason: 'not_started' } },
    ok('kernels', { source: 'cli' }),
  ],
});

async function fillLocal() {
  await userEvent.type(await screen.findByLabelText('Connection name'), 'My laptop');
  await userEvent.type(screen.getByLabelText('Working directory'), '/home/sam/notebooks');
  await userEvent.click(screen.getByRole('button', { name: 'Save and test connection' }));
}

describe('ConnectPanel', () => {
  it('A29 a session never shows Ready after SSH alone', async () => {
    // The connector has the session `ready` (service verified) but no kernel exists yet.
    const w = world({
      connections: [sshConnection()],
      sessions: [session({ state: 'starting' })],
      session: session({ state: 'starting' }),
    });
    serve(w);
    renderPanel();
    expect(await screen.findByText('Cluster · Python · Starting')).toBeInTheDocument();
    expect(screen.queryByText(/Ready|Connected/)).toBeNull();
  });

  it('A27 Ready is not shown before the kernel is idle', async () => {
    const w = world({
      connections: [sshConnection()],
      sessions: [session()],
      session: session(),
      kernel: kernel('starting'),
    });
    serve(w);
    renderPanel();
    expect(await screen.findByText('Cluster · Python · Starting')).toBeInTheDocument();
    expect(screen.getByText(/Waiting for the kernel to be idle/)).toBeInTheDocument();
    expect(screen.queryByText(/· Ready/)).toBeNull();
    w.kernel = kernel('idle');
    expect(await screen.findByText('Cluster · Python · Ready')).toBeInTheDocument();
  });

  it('A27 a session that is ready with no kernel gets its chosen kernel started, once', async () => {
    const w = world({
      connections: [sshConnection()],
      sessions: [session()],
      session: session(),
      kernel: null,
    });
    serve(w);
    renderPanel();
    await waitFor(() =>
      expect(w.posts.filter((p) => p.url.endsWith('/kernel'))).toEqual([
        {
          url: `/api/classes/${CLASS_A}/notebook-sessions/${SESSION}/kernel`,
          body: { kernelName: 'python3' },
        },
      ]),
    );
    expect(screen.queryByText(/· Ready/)).toBeNull();
  });

  it('saves a connection for This computer, tests it and offers Connect with the lease in words', async () => {
    const w = world();
    serve(w);
    renderPanel();
    await fillLocal();
    expect(await screen.findByRole('list', { name: 'Connection test' })).toBeInTheDocument();
    expect(w.posts[0]).toEqual({
      url: '/api/me/connections',
      body: {
        name: 'My laptop',
        connectorId: CONNECTOR,
        target: { kind: 'local', workspace: '/home/sam/notebooks' },
        runtime: { mode: 'start' },
      },
    });
    // Nothing offers Connect before the test passes.
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    w.test = READY_TEST;
    const connect = await screen.findByRole('button', { name: 'Connect' }, { timeout: 4000 });
    expect(screen.getByText('/home/sam/notebooks', { selector: 'dd' })).toBeInTheDocument();
    expect(
      screen.getByText(
        /Closing this tab keeps your kernel for 5 minutes\. An open notebook with no activity stops after 30 minutes\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/with that account's privileges/)).toBeInTheDocument();
    await userEvent.click(connect);
    await waitFor(() =>
      expect(
        w.posts.find((p) => p.url === `/api/classes/${CLASS_A}/notebook-sessions`)?.body,
      ).toEqual({
        connectionId: CONNECTION,
        revisionId: REVISION,
        runtime: { mode: 'start', kernelName: 'python3' },
        lease: { idleTimeoutMin: 30, gracePeriodMin: 5 },
      }),
    );
  });

  it('A30 a changed host key is not retried and is replaced only after confirmation', async () => {
    const w = world({
      connections: [sshConnection()],
      test: testView({
        outcome: 'failed',
        stages: [
          ok('reachability'),
          {
            name: 'host_identity',
            status: 'failed',
            code: 'host_key_changed',
            data: { hop: 'target', expected: FP_A, presented: FP_B },
          },
        ],
      }),
    });
    serve(w);
    renderPanel();
    await userEvent.selectOptions(await screen.findByLabelText('Saved connection'), 'Cluster');
    await userEvent.click(screen.getByRole('button', { name: 'Save and test connection' }));
    await screen.findByText(FP_B);
    await new Promise((r) => setTimeout(r, 1200));
    const tests = () => w.posts.filter((p) => p.url.endsWith('/test'));
    expect(tests()).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Replace trusted key…' }));
    expect(tests()).toHaveLength(1);
    await userEvent.click(
      screen.getByRole('button', { name: 'Replace key for node1.lab.example.org' }),
    );
    await waitFor(() => expect(tests()).toHaveLength(2));
    expect(tests()[1]?.body).toEqual({
      confirmations: [{ host: 'node1.lab.example.org', port: 22, sha256: FP_B, replacing: FP_A }],
    });
  });

  it('A30 replacing without a recent sign-in is refused in words and the key stays', async () => {
    const w = world({
      connections: [sshConnection()],
      test: testView({
        outcome: 'failed',
        stages: [
          {
            name: 'host_identity',
            status: 'failed',
            code: 'host_key_changed',
            data: { hop: 'target', expected: FP_A, presented: FP_B },
          },
        ],
      }),
    });
    serve(w);
    renderPanel();
    await userEvent.selectOptions(await screen.findByLabelText('Saved connection'), 'Cluster');
    await userEvent.click(screen.getByRole('button', { name: 'Save and test connection' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Replace trusted key…' }));
    w.refuseTest = { status: 401, error: 'recent_auth_required' };
    await userEvent.click(
      screen.getByRole('button', { name: 'Replace key for node1.lab.example.org' }),
    );
    expect(await screen.findByText(/needs a recent sign-in/)).toBeInTheDocument();
  });

  it('a first-use key is trusted only when Trust this key is pressed', async () => {
    const w = world({
      connections: [sshConnection()],
      test: testView({
        outcome: 'needs_action',
        stages: [
          ok('reachability'),
          {
            name: 'host_identity',
            status: 'needs_action',
            code: 'host_key_unknown',
            data: { hop: 'target', fingerprint: FP_A },
          },
        ],
      }),
    });
    serve(w);
    renderPanel();
    await userEvent.selectOptions(await screen.findByLabelText('Saved connection'), 'Cluster');
    await userEvent.click(screen.getByRole('button', { name: 'Save and test connection' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Trust this key' }));
    await waitFor(() =>
      expect(w.posts.filter((p) => p.url.endsWith('/test')).at(-1)?.body).toEqual({
        confirmations: [{ host: 'node1.lab.example.org', port: 22, sha256: FP_A }],
      }),
    );
  });

  it('an offline connector is said in words', async () => {
    const w = world({ refuseTest: { status: 409, error: 'connector_offline' } });
    serve(w);
    renderPanel();
    await fillLocal();
    expect(await screen.findByRole('alert')).toHaveTextContent(/not connected to Parallax/);
  });

  it('A36 a ready, idle session that becomes disconnected is replaced by the loss notice', async () => {
    const w = world({
      connections: [sshConnection()],
      sessions: [session()],
      session: session(),
      kernel: kernel('idle'),
    });
    serve(w);
    renderPanel();
    expect(await screen.findByText('Cluster · Python · Ready')).toBeInTheDocument();
    w.session = session({ state: 'disconnected', cause: 'sleep' });
    const alert = await screen.findByRole('alert', {}, { timeout: 6000 });
    expect(alert).toHaveTextContent('This computer was asleep.');
    expect(screen.queryByText(/· Ready/)).toBeNull();
  }, 15000);

  it('A36 Start a new session leaves a session that failed on its own', async () => {
    // The cached list still calls it starting; the session itself is failed.
    const w = world({
      connections: [sshConnection()],
      sessions: [session({ state: 'starting' })],
      session: session({ state: 'failed', cause: 'jupyter_missing' }),
    });
    serve(w);
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Start a new session' }));
    expect(await screen.findByLabelText('Connection name')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start a new session' })).toBeNull();
  });

  it('a refused Stop says why', async () => {
    const w = world({
      connections: [sshConnection()],
      sessions: [session()],
      session: session(),
      kernel: kernel('idle'),
      refuse: { status: 409, error: 'connector_offline' },
    });
    serve(w);
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Stop session' }));
    await userEvent.click(screen.getByRole('button', { name: 'Stop the session and its kernel' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not connected to Parallax/);
  });

  it('a refused Forget says why', async () => {
    const lost = session({ state: 'disconnected', cause: 'vpn' });
    const w = world({
      connections: [sshConnection()],
      sessions: [lost],
      session: lost,
      refuse: { status: 409, error: 'not_forgettable' },
    });
    serve(w);
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Forget this session' }));
    expect(await screen.findByText(/can no longer be given up on/)).toBeInTheDocument();
  });

  it('a kernel that would not start says so and can be started again', async () => {
    const w = world({
      connections: [sshConnection()],
      sessions: [session()],
      session: session(),
      kernel: null,
      refuse: { status: 409, error: 'not_ready' },
    });
    serve(w);
    renderPanel();
    expect(await screen.findByText(/The kernel could not be started/)).toBeInTheDocument();
    w.refuse = undefined;
    await userEvent.click(screen.getByRole('button', { name: 'Start the kernel again' }));
    await waitFor(() =>
      expect(
        w.posts.filter((p) => p.url.endsWith('/kernel') && !(p.body === undefined)),
      ).toHaveLength(2),
    );
  });

  it('a refused restart is retried as a restart, not as a start', async () => {
    const w = world({
      connections: [sshConnection()],
      sessions: [session()],
      session: session(),
      kernel: kernel('dead'),
      refuse: { status: 409, error: 'not_ready' },
    });
    serve(w);
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Restart the kernel' }));
    expect(await screen.findByText(/The kernel could not be restarted/)).toBeInTheDocument();
    w.refuse = undefined;
    w.kernel = kernel('restarting');
    await userEvent.click(screen.getByRole('button', { name: 'Restart the kernel' }));
    await waitFor(() =>
      expect(w.posts.filter((p) => p.url.endsWith('/kernel/restart'))).toHaveLength(2),
    );
    expect(w.posts.filter((p) => p.url.endsWith('/kernel'))).toHaveLength(0);
    await waitFor(() => expect(screen.queryByText(/The kernel could not be restarted/)).toBeNull());
  });

  it('a refused new kernel after a lost one is started again by the retry', async () => {
    const w = world({
      connections: [sshConnection()],
      sessions: [session({ cause: 'kernel_lost' })],
      session: session({ cause: 'kernel_lost' }),
      kernel: null,
      refuse: { status: 409, error: 'not_ready' },
    });
    serve(w);
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Start a new kernel' }));
    expect(await screen.findByText(/The kernel could not be started/)).toBeInTheDocument();
    expect(w.posts.filter((p) => p.url.endsWith('/kernel'))).toHaveLength(1);
    w.refuse = undefined;
    w.kernel = kernel('starting');
    await userEvent.click(screen.getByRole('button', { name: 'Start the kernel again' }));
    await waitFor(() => expect(w.posts.filter((p) => p.url.endsWith('/kernel'))).toHaveLength(2));
    expect(w.posts.filter((p) => p.url.endsWith('/kernel')).at(-1)?.body).toEqual({
      kernelName: 'python3',
    });
  });

  it('a kernel_failed refusal says why, with the catalogue copy and recovery', async () => {
    const w = world({
      connections: [sshConnection()],
      sessions: [session()],
      session: session(),
      kernel: null,
      refuse: { status: 409, error: 'kernel_failed', code: 'kernelspec_not_found' },
    });
    serve(w);
    renderPanel();
    const alert = await screen.findByText(/The kernel could not be started/);
    expect(alert).toHaveTextContent('The chosen kernel is not installed there.');
    expect(alert).toHaveTextContent('Choose another Python interpreter or kernel.');
  });

  it('a kernel_failed code the catalogue does not know keeps the plain sentence', async () => {
    const w = world({
      connections: [sshConnection()],
      sessions: [session()],
      session: session(),
      kernel: null,
      refuse: { status: 409, error: 'kernel_failed', code: 'jupyter_500' },
    });
    serve(w);
    renderPanel();
    expect(await screen.findByText('The kernel could not be started.')).toBeInTheDocument();
  });

  it('Escape in an open confirmation cancels it, returns focus, and keeps the form', async () => {
    const w = world({ connections: [], sessions: [] });
    serve(w);
    const { onClose } = renderPanel();
    const name = await screen.findByLabelText('Connection name');
    await userEvent.type(name, 'My laptop');

    // Rename
    await userEvent.click(await screen.findByRole('button', { name: 'Rename Laptop' }));
    await userEvent.type(screen.getByLabelText('New name for Laptop'), 'x');
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('New name for Laptop')).toBeNull();
    expect(screen.getByRole('button', { name: 'Rename Laptop' })).toHaveFocus();

    // Revoke
    await userEvent.click(screen.getByRole('button', { name: 'Revoke Laptop' }));
    screen.getByRole('button', { name: 'Revoke Laptop' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText(/does not revoke any SSH account/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Revoke Laptop' })).toHaveFocus();

    // The form kept what was typed, and Escape with nothing open closes the panel.
    expect(screen.getByLabelText('Connection name')).toHaveValue('My laptop');
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape in the replace-key confirmation cancels only that confirmation', async () => {
    const w = world({
      connections: [sshConnection()],
      test: testView({
        outcome: 'failed',
        stages: [
          {
            name: 'host_identity',
            status: 'failed',
            code: 'host_key_changed',
            data: { hop: 'target', expected: FP_A, presented: FP_B },
          },
        ],
      }),
    });
    serve(w);
    const { onClose } = renderPanel();
    await userEvent.selectOptions(await screen.findByLabelText('Saved connection'), 'Cluster');
    await userEvent.click(screen.getByRole('button', { name: 'Save and test connection' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Replace trusted key…' }));
    screen.getByRole('button', { name: 'Keep the trusted key' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Replace key for/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Replace trusted key…' })).toHaveFocus();
    expect(screen.getByLabelText('Saved connection')).toHaveValue(CONNECTION);
  });

  it('Escape in the stop confirmation keeps the session and returns focus', async () => {
    const w = world({
      connections: [sshConnection()],
      sessions: [session()],
      session: session(),
      kernel: kernel('idle'),
    });
    serve(w);
    const { onClose } = renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Stop session' }));
    screen.getByRole('button', { name: 'Keep it running' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Stop the session and its kernel' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop session' })).toHaveFocus();
  });

  it('A36 a lost kernel is not replaced silently: the warning shows and a new kernel starts only on request', async () => {
    const w = world({
      connections: [sshConnection()],
      sessions: [session({ cause: 'kernel_lost' })],
      session: session({ cause: 'kernel_lost' }),
      kernel: null,
    });
    serve(w);
    renderPanel();
    expect(
      await screen.findByText(/The kernel no longer exists\. Its variables are gone\./),
    ).toBeInTheDocument();
    expect(screen.getByText('Cluster · Python · No kernel')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 1500));
    expect(w.posts.filter((p) => p.url.endsWith('/kernel'))).toHaveLength(0);
    w.kernel = kernel('starting');
    await userEvent.click(screen.getByRole('button', { name: 'Start a new kernel' }));
    await waitFor(() => expect(w.posts.filter((p) => p.url.endsWith('/kernel'))).toHaveLength(1));
  });

  it('a dead kernel is said in words and offers a restart, not Starting', async () => {
    const w = world({
      connections: [sshConnection()],
      sessions: [session()],
      session: session(),
      kernel: kernel('dead'),
    });
    serve(w);
    renderPanel();
    expect(await screen.findByText('Cluster · Python · Kernel stopped')).toBeInTheDocument();
    expect(
      screen.getByText('The kernel is not running. Its variables are gone.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Starting|Waiting for the kernel/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Restart the kernel' }));
    await waitFor(() => expect(w.posts.at(-1)?.url).toMatch(/\/kernel\/restart$/));
  });

  it.each([
    ['restarting', 'Restarting'],
    ['waiting_for_input', 'Waiting for input'],
  ])('a %s kernel is labelled as it is', async (state, label) => {
    const w = world({
      connections: [sshConnection()],
      sessions: [session()],
      session: session(),
      kernel: kernel(state),
    });
    serve(w);
    renderPanel();
    expect(await screen.findByText(`Cluster · Python · ${label}`)).toBeInTheDocument();
  });

  it('a refused kernel start of one session is not shown for the next', async () => {
    const w = world({
      connections: [sshConnection()],
      sessions: [session()],
      session: session(),
      kernel: null,
      refuse: { status: 409, error: 'not_ready' },
    });
    serve(w);
    renderPanel();
    expect(await screen.findByText(/The kernel could not be started/)).toBeInTheDocument();
    // The first session ends; the person leaves it and a second one is open and starting normally.
    w.refuse = undefined;
    w.session = session({ state: 'failed', cause: 'jupyter_missing' });
    w.sessions = [session({ id: SESSION_B })];
    w.other = { session: session({ id: SESSION_B }), kernel: null };
    await userEvent.click(
      await screen.findByRole('button', { name: 'Start a new session' }, { timeout: 6000 }),
    );
    await waitFor(() => expect(screen.getByText(/Cluster · Python/)).toBeInTheDocument(), {
      timeout: 6000,
    });
    await waitFor(() => expect(w.posts.filter((p) => p.url.includes(SESSION_B))).toHaveLength(1));
    expect(screen.queryByText(/The kernel could not be started/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start the kernel again' })).toBeNull();
  }, 20000);

  it('a saved connection keeps its computer: it is named and cannot be changed', async () => {
    const w = world({
      connectors: [
        connector(),
        connector({ id: '00000000-0000-4000-8000-0000000a0002', name: 'Desktop' }),
      ],
      connections: [sshConnection()],
    });
    serve(w);
    renderPanel();
    await userEvent.selectOptions(await screen.findByLabelText('Saved connection'), 'Cluster');
    expect(screen.queryByLabelText('Computer running the connector')).toBeNull();
    const note = screen.getByText(/Save a new connection to use another/);
    expect(note.parentElement).toHaveTextContent('Laptop');
  });

  it('a disconnected session shows its cause and Forget', async () => {
    const lost = session({ state: 'disconnected', cause: 'vpn' });
    const w = world({ connections: [sshConnection()], sessions: [lost], session: lost });
    serve(w);
    renderPanel();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('A VPN connection went away');
    await userEvent.click(within(alert).getByRole('button', { name: 'Forget this session' }));
    await waitFor(() =>
      expect(w.posts.at(-1)?.url).toBe(
        `/api/classes/${CLASS_A}/notebook-sessions/${SESSION}/forget`,
      ),
    );
  });

  it('without an approved computer it asks for one before any target', async () => {
    serve(world({ connectors: [] }));
    renderPanel();
    expect(await screen.findByText(/Pair and approve a computer above/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Connection name')).toBeNull();
  });

  it('no field takes a password, a passphrase or a token', async () => {
    serve(world());
    renderPanel();
    await screen.findByLabelText('Connection name');
    await userEvent.click(screen.getByRole('radio', { name: 'SSH host' }));
    await userEvent.click(
      await screen.findByRole('radio', { name: "SSH agent on the connector's computer" }),
    );
    await userEvent.click(
      screen.getByRole('radio', { name: "Key file on the connector's computer" }),
    );
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);
    for (const input of Array.from(document.querySelectorAll('input'))) {
      expect(`${input.name} ${input.id}`).not.toMatch(/pass|secret|token/i);
    }
    expect(screen.queryByLabelText(/password|passphrase|token|secret/i)).toBeNull();
    expect(screen.getByText(/typed in the connector's terminal, never here/)).toBeInTheDocument();
  });

  it('warns on a login-node host that SSH access does not authorise computing there', async () => {
    serve(world());
    renderPanel();
    await userEvent.click(await screen.findByRole('radio', { name: 'SSH host' }));
    expect(screen.queryByRole('note')).toBeNull();
    await userEvent.type(await screen.findByLabelText('Host'), 'login.cluster.example.org');
    expect(screen.getByRole('note')).toHaveTextContent(/does not authorise computing there/);
  });

  it('opens with focus on its heading and closes on Escape', async () => {
    serve(world());
    const { onClose } = renderPanel();
    const heading = await screen.findByRole('heading', { name: 'Connect a computer' });
    await waitFor(() => expect(heading).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('has no accessibility violations with a test in progress', async () => {
    const w = world({
      test: testView({
        state: 'running',
        stages: [ok('workspace'), { name: 'runtime', status: 'failed', code: 'jupyter_missing' }],
      }),
    });
    serve(w);
    const { container } = renderPanel();
    await fillLocal();
    await screen.findByRole('list', { name: 'Connection test' });
    const results = await axe.run(container, {
      // jsdom has no layout or computed colour.
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

describe('the notebook toolbar opens the panel', () => {
  it('opens from the target label and returns focus to it on Close and on Escape', async () => {
    const me = makeMe({ classes: [studentIn(CLASS_A, 'Class A')] });
    const REV = REVISION;
    stubApi((url) => {
      if (url === '/api/me') return { status: 200, body: me };
      if (url === `/api/classes/${CLASS_A}/topics`) return { status: 200, body: makeTopics() };
      if (url === `/api/classes/${CLASS_A}/topics/${T_SAMPLING}/notebooks`) {
        return {
          status: 200,
          body: {
            notebooks: [
              {
                resourceId: '00000000-0000-4000-8000-000000000401',
                revisionId: REV,
                title: 'Repeated samples',
                type: 'notebook',
              },
            ],
          },
        };
      }
      if (url === `/api/classes/${CLASS_A}/resources/${REV}/notebook`) {
        return {
          status: 200,
          body: {
            revisionId: REV,
            title: 'Repeated samples',
            status: 'ready',
            error: null,
            sourceKey: `courses/${COURSE}/objects/${'b'.repeat(64)}`,
            notebook: {
              kernel: 'Python 3',
              language: 'python',
              outline: [],
              cells: [{ id: 'intro', type: 'markdown', html: '<p>Draw samples.</p>' }],
            },
          },
        };
      }
      if (url === '/api/me/connectors') return { status: 200, body: [connector()] };
      if (url === '/api/me/connections') return { status: 200, body: [] };
      if (url.endsWith('/notebook-sessions')) return { status: 200, body: [] };
      return { status: 404, body: {} };
    });
    renderApp(`/classes/${CLASS_A}/topics/${T_SAMPLING}/notebooks`);
    const opener = await screen.findByRole('button', { name: 'Saved outputs' });
    expect(opener).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(opener);
    const heading = await screen.findByRole('heading', { name: 'Connect a computer' });
    expect(opener).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(heading).toHaveFocus());
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('heading', { name: 'Connect a computer' })).toBeNull();
    expect(opener).toHaveFocus();
    await userEvent.click(opener);
    await screen.findByRole('heading', { name: 'Connect a computer' });
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('heading', { name: 'Connect a computer' })).toBeNull();
    expect(opener).toHaveFocus();
  });
});

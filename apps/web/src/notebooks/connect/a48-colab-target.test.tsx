import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../session/revocation';
import { CLASS_A, makeMe, stubApi } from '../../test/render';
import type { Stage } from './api';
import { ConnectPanel } from './ConnectPanel';
import { ConnectSummary } from './ConnectSummary';
import {
  connector,
  FP_A,
  FP_B,
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

const COLAB = 'Colab over SSH (paid Colab plan)';
const TARGET = {
  kind: 'colab' as const,
  user: 'root',
  auth: { method: 'key' as const, keyPath: '~/.ssh/colab' },
  workspace: '/content',
};
const colab = () => sshConnection({ name: 'Colab', target: TARGET });
const TRUST = { host: 'colab.invalid', port: 22 };

type World = { posts: { url: string; body: unknown }[] } & Record<string, unknown>;

/** The API for the panel, from state a test can change between polls. */
function serve(over: Record<string, unknown>): World {
  const w: World = { connectors: [connector()], connections: [], posts: [], ...over };
  stubApi((url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET') w.posts.push({ url, body });
    if (url === '/api/me') return { status: 200, body: makeMe() };
    if (url === '/api/me/connectors') return { status: 200, body: w.connectors };
    if (url === '/api/me/connections' && !body) return { status: 200, body: w.connections };
    if (/^\/api\/me\/connections(\/[^/]+)?$/.test(url))
      return { status: method === 'POST' ? 201 : 200, body: { ...colab(), ...body } };
    if (url.endsWith('/test')) return { status: 202, body: { testId: TEST_ID } };
    if (url.endsWith(`/tests/${TEST_ID}`)) return { status: 200, body: w.test };
    const sessions = `/api/classes/${CLASS_A}/notebook-sessions`;
    if (url === sessions && method === 'POST')
      return { status: 202, body: { sessionId: SESSION, state: 'starting' } };
    if (url === `${sessions}/${SESSION}` && w.session) return { status: 200, body: w.session };
    if (url === `${sessions}/${SESSION}/kernel`) return { status: 200, body: { kernel: w.kernel } };
    return { status: 404, body: {} };
  });
  return w;
}

function renderPanel() {
  return render(
    <QueryClientProvider client={createQueryClient({ retry: false })}>
      <ConnectPanel classId={CLASS_A} revisionId={REVISION} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

async function saveColab() {
  await userEvent.click(await screen.findByRole('radio', { name: COLAB }));
  await userEvent.type(screen.getByLabelText('Connection name'), 'Colab');
  await userEvent.type(screen.getByLabelText('Account'), 'root');
  await userEvent.type(screen.getByLabelText('Key file path'), '~/.ssh/colab');
  await userEvent.type(screen.getByLabelText('Working directory'), '/content');
  await userEvent.click(screen.getByRole('button', { name: 'Save and test connection' }));
}

const tests = (w: World) => w.posts.filter((p) => p.url.endsWith('/test'));
const identity = (
  data: Stage['data'],
  status: Stage['status'] = 'needs_action',
  code = 'host_key_unknown',
) =>
  testView({
    outcome: status === 'failed' ? 'failed' : 'needs_action',
    stages: [ok('reachability'), { name: 'host_identity', status, code, data }],
  });

describe('A48 Colab over SSH in the Connect panel', () => {
  it('A48 the Connect panel offers Colab over SSH for paid Colab plans and sends free Colab to Work in Colab', async () => {
    serve({});
    const { container } = renderPanel();
    await userEvent.click(await screen.findByRole('radio', { name: COLAB }));
    for (const field of ['Account', 'Key file path', 'Working directory']) {
      expect(screen.getByLabelText(field)).toBeInTheDocument();
    }
    expect(
      screen.getByRole('radio', { name: "SSH agent on the connector's computer" }),
    ).toBeVisible();
    expect(screen.getByRole('group', { name: 'Jupyter' })).toBeInTheDocument();
    for (const field of ['Host', 'Port', 'Jump host']) {
      expect(screen.queryByLabelText(field)).toBeNull();
    }
    expect(screen.queryByText(/jump host/i)).toBeNull();
    expect(
      screen.getByText(
        'For a paid Colab plan with a positive compute-unit balance. With free Colab, use Work in Colab on this notebook: open it in Colab, then upload your copy.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The computer running the connector needs Google's colab program, signed in.",
      ),
    ).toBeInTheDocument();
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });

  it('A48 a Colab connection is saved with no host, port or command, and its runtime key is confirmed as this Colab runtime', async () => {
    const w = serve({ test: identity({ hop: 'target', fingerprint: FP_A }) });
    renderPanel();
    await saveColab();
    await waitFor(() => expect(w.posts[0]?.url).toBe('/api/me/connections'));
    expect(w.posts[0]?.body).toHaveProperty('target', TARGET);
    expect(await screen.findByText(/^First connection to this Colab runtime\./)).toBeVisible();
    expect(screen.getByText('Trust it only if you started this Colab runtime.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Trust this key' }));
    await waitFor(() =>
      expect(tests(w).at(-1)?.body).toEqual({ confirmations: [{ ...TRUST, sha256: FP_A }] }),
    );

    cleanup();
    const changed = { hop: 'target' as const, expected: FP_A, presented: FP_B };
    const v = serve({
      connections: [colab()],
      test: identity(changed, 'failed', 'host_key_changed'),
    });
    renderPanel();
    await userEvent.selectOptions(await screen.findByLabelText('Saved connection'), 'Colab');
    await userEvent.click(screen.getByRole('button', { name: 'Save and test connection' }));
    expect(await screen.findByText(FP_B)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Replace trusted key…' }));
    expect(tests(v)).toHaveLength(1);
    expect(screen.getByText(/Replace it only if you started a new Colab runtime\./)).toBeVisible();
    await userEvent.click(
      screen.getByRole('button', { name: 'Replace key for this Colab runtime' }),
    );
    await waitFor(() =>
      expect(tests(v).at(-1)?.body).toEqual({
        confirmations: [{ ...TRUST, sha256: FP_B, replacing: FP_A }],
      }),
    );
  });

  it('the Windows connector does not offer Colab over SSH, and the form says what to run instead', async () => {
    const w = serve({ connectors: [connector({ os: 'windows' })] });
    renderPanel();
    await saveColab();
    expect(
      screen.getByText(
        'The Windows connector does not offer Colab over SSH. Run the Linux connector inside WSL, or choose a Linux or Mac computer.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save and test connection' })).toBeDisabled();
    expect(w.posts).toEqual([]);
  });

  it("a Colab connection's summary names the Colab runtime and its account, never this computer", () => {
    const { container } = render(
      <ConnectSummary
        connection={colab()}
        connector={connector({ name: "Sam's MacBook" })}
        test={testView({ outcome: 'ready_to_start' })}
        busy={false}
        onConnect={vi.fn()}
      />,
    );
    const value = (term: string) => screen.getByText(term, { selector: 'dt' }).nextElementSibling;
    expect(value('Computer')).toHaveTextContent(/^the Colab runtime$/);
    expect(value('Account')).toHaveTextContent(/^root$/);
    for (const text of ['This computer', "Sam's MacBook", 'the account running the connector']) {
      expect(container.textContent).not.toContain(text);
    }
  });

  it('a Colab session shows Ready only once its kernel is idle', async () => {
    const kernel = (state: string) => ({ id: SESSION, name: 'python3', state, generation: 0 });
    const w = serve({
      test: testView({
        outcome: 'ready_to_start',
        kernelspecs: [{ name: 'python3', displayName: 'Python 3', language: 'python' }],
        stages: [
          ok('reachability'),
          ok('host_identity', { hops: [{ hop: 'target', fingerprint: FP_A }] }),
          ok('ssh_auth'),
          ok('workspace'),
        ],
      }),
      session: session({ state: 'ready' }),
      kernel: kernel('starting'),
    });
    renderPanel();
    await saveColab();
    expect(await screen.findByText('the Colab runtime', { selector: 'dd' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(/· Python · Starting$/)).toBeVisible();
    expect(screen.queryByText(/Ready|Connected/)).toBeNull();
    w.kernel = kernel('idle');
    expect(await screen.findByText(/· Python · Ready$/, {}, { timeout: 4000 })).toBeVisible();
  });
});

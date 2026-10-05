import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionTest, Stage } from './api';
import { FP_A, FP_B, ok, testView } from './fixtures';
import { StageList } from './StageList';

afterEach(cleanup);

const hosts = { target: { host: 'node1.lab.example.org', port: 22 } };
const blocked = (by: 'host_identity' | 'ssh_auth', names: Stage['name'][]): Stage[] =>
  names.map((name) => ({
    name,
    status: 'skipped',
    data: { reason: 'blocked', blockedBy: by },
  }));
const LATER: Stage['name'][] = ['workspace', 'forwarding', 'runtime', 'notebook_auth', 'kernels'];

function setup(
  test: ConnectionTest | undefined,
  opts: { jump?: boolean; kind?: 'ssh' | 'local' } = {},
) {
  const on = { onTrust: vi.fn(), onReplace: vi.fn(), onRetest: vi.fn() };
  render(
    <StageList
      kind={opts.kind ?? 'ssh'}
      test={test}
      hosts={
        opts.jump ? { ...hosts, jump: { host: 'bastion.lab.example.org', port: 2222 } } : hosts
      }
      busy={false}
      {...on}
    />,
  );
  return on;
}
const row = (name: string) => {
  const el = document.querySelector<HTMLElement>(`[data-stage="${name}"]`);
  if (!el) throw new Error(`no row ${name}`);
  return within(el);
};

describe('StageList', () => {
  it('A29 the failing stage is named and the recovery shown', () => {
    setup(
      testView({
        outcome: 'failed',
        stages: [
          ok('reachability'),
          ok('host_identity', { hops: [{ hop: 'target', fingerprint: FP_A }] }),
          { name: 'ssh_auth', status: 'failed', code: 'key_file_unreadable' },
          ...blocked('ssh_auth', LATER),
        ],
      }),
    );
    const failed = row('ssh_auth');
    expect(failed.getByText(/Sign in over SSH failed\./)).toBeInTheDocument();
    expect(
      failed.getByText(/key file is missing or this connector cannot read it/),
    ).toBeInTheDocument();
    expect(failed.getByText('Choose a key file the connector can read.')).toBeInTheDocument();
    expect(
      failed.getByText('Load the key into an SSH agent on the connector computer.'),
    ).toBeInTheDocument();
    expect(row('reachability').getByText('Passed')).toBeInTheDocument();
    expect(row('runtime').getByText('Not run')).toBeInTheDocument();
    expect(
      row('runtime').getByText('Not run because sign in over ssh did not pass.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Connected|Ready/)).toBeNull();
  });

  it('A29 a stage the connector has not reported yet is waiting, never passed', () => {
    setup(testView({ state: 'running', stages: [ok('reachability')] }));
    expect(row('reachability').getByText('Passed')).toBeInTheDocument();
    expect(row('host_identity').getByText('Waiting')).toBeInTheDocument();
    expect(row('kernels').getByText('Waiting')).toBeInTheDocument();
  });

  it('a local target lists only the four stages it runs', () => {
    setup(testView({ state: 'running', stages: [] }), { kind: 'local' });
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(screen.queryByText('Reach the host')).toBeNull();
  });

  it('waiting for the connector’s terminal is shown as such and announced', () => {
    setup(
      testView({
        state: 'running',
        stages: [
          ok('reachability'),
          ok('host_identity', { hops: [{ hop: 'target', fingerprint: FP_A }] }),
          { name: 'ssh_auth', status: 'running', data: { hop: 'target', terminalPrompt: true } },
        ],
      }),
    );
    expect(
      row('ssh_auth').getByText(/answer the prompt in the connector's terminal/),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      "Sign in over SSH: waiting for you to answer in the connector's terminal.",
    );
  });

  it('a screen reader hears each stage as it finishes', () => {
    const { rerender } = render(
      <StageList
        kind="ssh"
        test={testView({ state: 'running', stages: [ok('reachability')] })}
        hosts={hosts}
        busy={false}
        onTrust={vi.fn()}
        onReplace={vi.fn()}
        onRetest={vi.fn()}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Reach the host: passed.');
    rerender(
      <StageList
        kind="ssh"
        test={testView({
          state: 'running',
          stages: [
            ok('reachability'),
            {
              name: 'host_identity',
              status: 'failed',
              code: 'host_key_changed',
              data: { hop: 'target', expected: FP_A, presented: FP_B },
            },
          ],
        })}
        hosts={hosts}
        busy={false}
        onTrust={vi.fn()}
        onReplace={vi.fn()}
        onRetest={vi.fn()}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Check the host key: failed.');
  });

  it('a first-use key shows its fingerprint and trusts it only when asked', async () => {
    const on = setup(
      testView({
        outcome: 'needs_action',
        stages: [
          ok('reachability'),
          {
            name: 'host_identity',
            status: 'needs_action',
            code: 'host_key_unknown',
            data: { hop: 'target', fingerprint: FP_A },
          },
          ...blocked('host_identity', ['ssh_auth', ...LATER]),
        ],
      }),
    );
    expect(screen.getByText(FP_A)).toBeInTheDocument();
    expect(on.onTrust).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Trust this key' }));
    expect(on.onTrust).toHaveBeenCalledWith({
      host: 'node1.lab.example.org',
      port: 22,
      sha256: FP_A,
    });
  });

  it('a key confirmation for a jump host names the jump host', async () => {
    const on = setup(
      testView({
        outcome: 'needs_action',
        stages: [
          {
            name: 'host_identity',
            status: 'needs_action',
            code: 'host_key_unknown',
            data: { hop: 'jump', fingerprint: FP_B },
          },
        ],
      }),
      { jump: true },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Trust this key' }));
    expect(on.onTrust).toHaveBeenCalledWith({
      host: 'bastion.lab.example.org',
      port: 2222,
      sha256: FP_B,
    });
  });

  const changed = testView({
    outcome: 'failed',
    stages: [
      ok('reachability'),
      {
        name: 'host_identity',
        status: 'failed',
        code: 'host_key_changed',
        data: { hop: 'target', expected: FP_A, presented: FP_B },
      },
      ...blocked('host_identity', ['ssh_auth', ...LATER]),
    ],
  });

  it('A30 a changed host key stops the connection and offers Replace only behind a confirmation', async () => {
    const on = setup(changed);
    // Both fingerprints, the stop, and no automatic retry.
    expect(screen.getByText(FP_A)).toBeInTheDocument();
    expect(screen.getByText(FP_B)).toBeInTheDocument();
    expect(screen.getByText(/The connection was stopped/)).toBeInTheDocument();
    expect(row('ssh_auth').getByText('Not run')).toBeInTheDocument();
    expect(on.onReplace).not.toHaveBeenCalled();
    expect(on.onRetest).not.toHaveBeenCalled();
    // No replace action until it is asked for, and no Trust this key for a key that changed.
    expect(screen.queryByRole('button', { name: /Replace key for/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Trust this key' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Replace trusted key…' }));
    expect(on.onReplace).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Replace the trusted key for node1\.lab\.example\.org:22\?/),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Replace key for node1.lab.example.org' }),
    );
    expect(on.onReplace).toHaveBeenCalledWith({
      host: 'node1.lab.example.org',
      port: 22,
      sha256: FP_B,
      replacing: FP_A,
    });
  });

  it('A30 keeping the trusted key leaves everything as it was', async () => {
    const on = setup(changed);
    await userEvent.click(screen.getByRole('button', { name: 'Replace trusted key…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Keep the trusted key' }));
    expect(on.onReplace).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Replace trusted key…' })).toBeInTheDocument();
  });

  it('a failed test offers Test again, which only runs when pressed', async () => {
    const on = setup(
      testView({
        outcome: 'failed',
        stages: [{ name: 'reachability', status: 'failed', code: 'connection_timeout' }],
      }),
    );
    expect(on.onRetest).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Test again' }));
    expect(on.onRetest).toHaveBeenCalledTimes(1);
  });

  it('a test that ended without a result names its code', () => {
    setup(testView({ outcome: 'failed', code: 'connector_offline', stages: [] }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'That computer is not connected to Parallax.',
    );
  });
});

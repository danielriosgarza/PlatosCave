import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../session/revocation';
import { stubApi } from '../../test/render';
import { DeviceList } from './DeviceList';
import { CONNECTOR, connector } from './fixtures';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderList = () =>
  render(
    <QueryClientProvider client={createQueryClient({ retry: false })}>
      <DeviceList />
    </QueryClientProvider>,
  );

describe('DeviceList', () => {
  it('lists a connector with its system, version, state and fingerprint', async () => {
    stubApi(() => ({ status: 200, body: [connector()] }));
    renderList();
    const list = await screen.findByRole('list', { name: 'Your computers' });
    expect(within(list).getByText('Laptop')).toBeInTheDocument();
    expect(within(list).getByText('Online')).toBeInTheDocument();
    expect(within(list).getByText(/linux amd64 · connector 0\.1\.0/)).toBeInTheDocument();
    expect(within(list).getByText(connector().fingerprint)).toBeInTheDocument();
  });

  it('a computer that holds no link is offline, not online', async () => {
    stubApi(() => ({ status: 200, body: [connector({ online: false })] }));
    renderList();
    expect(await screen.findByText('Offline')).toBeInTheDocument();
    expect(screen.queryByText('Online')).toBeNull();
  });

  it('with no computer it says so and offers the pairing line with its code and expiry', async () => {
    const fetchMock = stubApi((_url, init) =>
      init?.method === 'POST'
        ? {
            status: 201,
            body: {
              pairingId: CONNECTOR,
              code: 'K7M2-Q9XD',
              expiresAt: '2026-10-05T10:00:00Z',
            },
          }
        : { status: 200, body: [] },
    );
    renderList();
    expect(await screen.findByText(/No computer is paired/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Pair a computer' }));
    expect(
      await screen.findByText(
        `parallax-connector pair --server ${window.location.origin} --code K7M2-Q9XD`,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/The code works once and expires at/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/me/connectors/pairings',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('a pending computer is approved only after its fingerprint is shown and Approve is pressed', async () => {
    let status = 'pending';
    const fetchMock = stubApi((url) => {
      if (url === `/api/me/connectors/${CONNECTOR}/approve`) {
        status = 'active';
        return { status: 200, body: connector({ status: 'active' }) };
      }
      return {
        status: 200,
        body: [connector({ status: status as 'pending', approveBy: '2026-10-05T10:15:00Z' })],
      };
    });
    renderList();
    expect(await screen.findByText('Waiting for approval')).toBeInTheDocument();
    expect(screen.getByText(connector().fingerprint)).toBeInTheDocument();
    expect(screen.getByText(/matches the one the connector printed/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/approve'),
      expect.anything(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Approve Laptop' }));
    expect(await screen.findByText('Online')).toBeInTheDocument();
  });

  it('approving without a recent sign-in says so', async () => {
    stubApi((url) =>
      url.endsWith('/approve')
        ? { status: 401, body: { error: 'recent_auth_required' } }
        : { status: 200, body: [connector({ status: 'pending' })] },
    );
    renderList();
    await userEvent.click(await screen.findByRole('button', { name: 'Approve Laptop' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/needs a recent sign-in/);
  });

  it('rejecting a pending computer revokes it', async () => {
    const fetchMock = stubApi((url) =>
      url.endsWith('/revoke')
        ? { status: 200, body: connector({ status: 'revoked' }) }
        : { status: 200, body: [connector({ status: 'pending' })] },
    );
    renderList();
    await userEvent.click(await screen.findByRole('button', { name: 'Reject Laptop' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/me/connectors/${CONNECTOR}/revoke`,
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('revoking an active computer asks first and says what it does not do', async () => {
    const fetchMock = stubApi((url) =>
      url.endsWith('/revoke')
        ? { status: 200, body: connector({ status: 'revoked' }) }
        : { status: 200, body: [connector()] },
    );
    renderList();
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke Laptop' }));
    expect(screen.getByText(/does not revoke any SSH account/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/revoke'),
      expect.anything(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Revoke Laptop' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/me/connectors/${CONNECTOR}/revoke`,
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('renames a computer', async () => {
    const fetchMock = stubApi((_url, init) =>
      init?.method === 'PATCH'
        ? { status: 200, body: connector({ name: 'Lab workstation' }) }
        : { status: 200, body: [connector()] },
    );
    renderList();
    await userEvent.click(await screen.findByRole('button', { name: 'Rename Laptop' }));
    const input = screen.getByLabelText('New name for Laptop');
    await userEvent.clear(input);
    await userEvent.type(input, 'Lab workstation');
    await userEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(call?.[1]?.body).toBe(JSON.stringify({ name: 'Lab workstation' }));
    });
  });
});

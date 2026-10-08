import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { session } from './fixtures';
import { LossNotice } from './LossNotice';
import { RECOVERY_COPY } from './messages';

afterEach(cleanup);

function setup(over: Parameters<typeof session>[0]) {
  const on = {
    onReconnect: vi.fn(),
    onForget: vi.fn(),
    onChooseAnother: vi.fn(),
    onNewSession: vi.fn(),
  };
  render(<LossNotice session={session(over)} busy={false} {...on} />);
  return on;
}

describe('LossNotice', () => {
  it('A36 a lost session shows its cause, keeps the notebook editable and offers Forget', async () => {
    const on = setup({ state: 'disconnected', cause: 'sleep' });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('This session is disconnected.');
    expect(alert).toHaveTextContent('This computer was asleep.');
    expect(alert).toHaveTextContent('Your edits to the notebook are kept.');
    expect(alert).toHaveTextContent(
      'does not know whether the process on that computer still runs',
    );
    // It never calls a disconnect a completion or promises the old process survived.
    expect(alert).not.toHaveTextContent(/completed|finished|survived/i);
    await userEvent.click(screen.getByRole('button', { name: 'Forget this session' }));
    expect(on.onForget).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(on.onReconnect).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['vpn', 'A VPN connection went away'],
    ['network_change', "This computer's network changed."],
    ['ssh_timeout', 'The SSH connection stopped answering.'],
    ['service_stopped', 'the Jupyter service is no longer running'],
    ['allocation_expired', 'allocation on that computer ended'],
    ['link_lost', 'Parallax stopped hearing from the connector'],
  ])('A36 cause %s is said in words', (cause, text) => {
    setup({ state: cause === 'link_lost' ? 'unconfirmed' : 'disconnected', cause });
    expect(screen.getByRole('alert')).toHaveTextContent(text);
  });

  it('A36 an unconfirmed session says Parallax cannot confirm it', () => {
    setup({ state: 'unconfirmed', cause: 'link_lost' });
    expect(screen.getByRole('alert')).toHaveTextContent('Parallax cannot confirm this session.');
  });

  it('A36 a stopped session offers a new session or another target, not Forget', async () => {
    const on = setup({ state: 'stopped', cause: 'abandoned' });
    expect(screen.getByRole('alert')).toHaveTextContent('You gave up on this session.');
    expect(screen.queryByRole('button', { name: 'Forget this session' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Choose another target' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start a new session' }));
    expect(on.onChooseAnother).toHaveBeenCalledTimes(1);
    expect(on.onNewSession).toHaveBeenCalledTimes(1);
  });

  it('A36 a stop the connector has not confirmed is stopping, not disconnected, and can be forgotten', async () => {
    const on = setup({ state: 'stopping', cause: null });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Stopping this session.');
    expect(alert).toHaveTextContent('has not confirmed that it stopped');
    expect(alert).not.toHaveTextContent(/disconnected|reason Parallax does not recognise/);
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Forget this session' }));
    expect(on.onForget).toHaveBeenCalledTimes(1);
  });

  it('a session that failed to start shows the catalogue text for its code', () => {
    setup({ state: 'failed', cause: 'jupyter_missing' });
    expect(screen.getByRole('alert')).toHaveTextContent('This session could not start.');
    expect(screen.getByRole('alert')).toHaveTextContent('Jupyter Server is not installed');
  });

  it('A29 a session that failed at a stage names it and shows the code’s recoveries', () => {
    setup({ state: 'failed', cause: 'token_rejected' });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      "Reach the notebook service failed. Jupyter rejected the connector's token.",
    );
    expect(alert).toHaveTextContent(RECOVERY_COPY.choose_environment ?? 'missing');
    expect(alert).toHaveTextContent(RECOVERY_COPY.contact_host_owner ?? 'missing');
  });
});

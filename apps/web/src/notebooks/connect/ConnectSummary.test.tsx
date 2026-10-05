import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectSummary } from './ConnectSummary';
import { connector, sshConnection, testView } from './fixtures';

afterEach(cleanup);

function setup() {
  const onConnect = vi.fn();
  render(
    <ConnectSummary
      connection={sshConnection()}
      connector={connector()}
      test={testView({ outcome: 'ready_to_start' })}
      busy={false}
      onConnect={onConnect}
    />,
  );
  return onConnect;
}

describe('ConnectSummary', () => {
  it('a lease value of 20 or 120 minutes can be typed after clearing the field', async () => {
    const onConnect = setup();
    const idle = screen.getByLabelText(/Stop after minutes with no activity/);
    await userEvent.clear(idle);
    await userEvent.type(idle, '120');
    expect(idle).toHaveValue('120');
    const grace = screen.getByLabelText(/Keep the kernel after closing this tab/);
    await userEvent.clear(grace);
    await userEvent.type(grace, '20');
    expect(screen.getByText(/keeps your kernel for 20 minutes/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ idleTimeoutMin: 120, gracePeriodMin: 20 }),
    );
  });

  it('a value out of range is refused in words and nothing connects', async () => {
    const onConnect = setup();
    const idle = screen.getByLabelText(/Stop after minutes with no activity/);
    await userEvent.clear(idle);
    await userEvent.type(idle, '3');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(screen.getByRole('alert')).toHaveTextContent('from 5 to 240');
    expect(onConnect).not.toHaveBeenCalled();
  });
});

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComputeTemplate } from './api';
import { ConnectSummary } from './ConnectSummary';
import { connector, sshConnection, testView } from './fixtures';

afterEach(cleanup);

function setup(defaultLease?: { idleTimeoutMin: number; gracePeriodMin: number }) {
  const onConnect = vi.fn();
  render(
    <ConnectSummary
      connection={sshConnection()}
      connector={connector()}
      test={testView({ outcome: 'ready_to_start' })}
      defaultLease={defaultLease}
      busy={false}
      onConnect={onConnect}
    />,
  );
  return onConnect;
}

describe('ConnectSummary', () => {
  it("pre-fills the operator's default lease and sends it", async () => {
    const onConnect = setup({ idleTimeoutMin: 60, gracePeriodMin: 15 });
    expect(screen.getByLabelText(/Stop after minutes with no activity/)).toHaveValue('60');
    expect(screen.getByText(/keeps your kernel for 15 minutes/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ idleTimeoutMin: 60, gracePeriodMin: 15 }),
    );
  });

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

  it('A33 a class computer that sets a lease holds it: the times cannot be changed', async () => {
    const onConnect = vi.fn();
    const template = {
      id: '00000000-0000-4000-8000-0000000f0001',
      classId: '00000000-0000-4000-8000-000000000a01',
      name: 'Department cluster',
      description: '',
      target: { host: 'jupyter.cluster.example.org', port: 22, workspace: '/home/{user}/work' },
      runtime: { mode: 'start' },
      isolation: 'account',
      lease: { idleTimeoutMin: 90, gracePeriodMin: 15 },
      hostOwnerConfirmedAt: '2026-10-04T09:00:00Z',
      createdAt: '2026-10-04T09:00:00Z',
      archivedAt: null,
    } satisfies ComputeTemplate;
    render(
      <ConnectSummary
        connection={sshConnection({ templateId: template.id })}
        connector={connector()}
        template={template}
        test={testView({ outcome: 'ready_to_start' })}
        defaultLease={{ idleTimeoutMin: 30, gracePeriodMin: 5 }}
        busy={false}
        onConnect={onConnect}
      />,
    );
    const idle = screen.getByLabelText(/Stop after minutes with no activity/);
    expect(idle).toHaveValue('90');
    expect(idle).toHaveAttribute('readonly');
    await userEvent.type(idle, '0');
    expect(idle).toHaveValue('90');
    expect(screen.getByLabelText(/Keep the kernel after closing this tab/)).toHaveAttribute(
      'readonly',
    );
    expect(screen.getByText(/instructor set these times/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ idleTimeoutMin: 90, gracePeriodMin: 15 }),
    );
  });
});

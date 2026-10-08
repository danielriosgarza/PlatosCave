import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SaveLine } from './SaveLine';

afterEach(cleanup);

describe('SaveLine', () => {
  it.each([
    ['saving', 'Saving'],
    ['saved', 'Saved'],
    ['offline', 'Offline · changes on this device'],
  ] as const)('A03 %s says "%s"', (status, text) => {
    render(<SaveLine status={status} onRetry={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent(new RegExp(`^${text}$`));
  });

  it('A03 idle says nothing, so "Saved" is never claimed without an acknowledgement', () => {
    render(<SaveLine status="idle" onRetry={() => {}} />);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('A03 a failed save says Could not save with a Retry control', async () => {
    const onRetry = vi.fn();
    render(<SaveLine status="failed" onRetry={onRetry} />);
    expect(screen.getByRole('status')).toHaveTextContent('Could not save · Retry');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('A03 a reason replaces "Could not save" and Retry stays', () => {
    render(<SaveLine status="failed" reason="The note is too long" onRetry={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent('The note is too long · Retry');
  });
});

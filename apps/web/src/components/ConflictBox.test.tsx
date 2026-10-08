import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConflictBox } from './ConflictBox';

afterEach(cleanup);

describe('ConflictBox', () => {
  it('A03 shows each version and makes the choice explicit', async () => {
    const user = userEvent.setup();
    const onKeep = vi.fn();
    const onUse = vi.fn();
    render(
      <ConflictBox
        title="This note changed somewhere else"
        versions={[
          { label: 'Your text on this device', text: 'mine' },
          { label: 'Saved version', text: 'theirs' },
        ]}
        keepLabel="Keep my text"
        useLabel="Use the saved version"
        onKeep={onKeep}
        onUse={onUse}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('This note changed somewhere else');
    expect(screen.getByText('mine')).toBeInTheDocument();
    expect(screen.getByText('theirs')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep my text' }));
    await user.click(screen.getByRole('button', { name: 'Use the saved version' }));
    expect(onKeep).toHaveBeenCalledOnce();
    expect(onUse).toHaveBeenCalledOnce();
  });
});

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Dialog } from './Dialogs';

afterEach(cleanup);

function Page({ openerGoneOnOpen = false }: { openerGoneOnOpen?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <h1>Your courses</h1>
      {open && openerGoneOnOpen ? null : (
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
      )}
      <button type="button">Behind</button>
      {open ? (
        <Dialog title="Sheet" onClose={() => setOpen(false)}>
          <input aria-label="Code" />
          <button type="button">Submit</button>
        </Dialog>
      ) : null}
    </main>
  );
}

describe('Dialog', () => {
  it('A02 the page behind the dialog is inert while it is open and not after it closes', async () => {
    const user = userEvent.setup();
    const { container } = render(<Page />);
    expect(container.hasAttribute('inert')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(container.hasAttribute('inert')).toBe(true);
    expect(screen.getByRole('dialog').closest('[inert]')).toBeNull();
    await user.keyboard('{Escape}');
    expect(container.hasAttribute('inert')).toBe(false);
  });

  it('A02 Tab and Shift+Tab stay inside the dialog', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByLabelText('Code')).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Submit' })).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText('Code')).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Submit' })).toHaveFocus();
  });

  it('A02 Escape closes from any focused control and focus returns to the opener', async () => {
    const user = userEvent.setup();
    render(<Page />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Submit' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('A02 focus returns to the page heading when the opener is gone', async () => {
    const user = userEvent.setup();
    render(<Page openerGoneOnOpen />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Your courses' })).toHaveFocus();
  });
});

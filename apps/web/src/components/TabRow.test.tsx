import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { TabRow } from './TabRow';

afterEach(cleanup);

const TABS = [
  { id: 'a', label: 'Slides' },
  { id: 'b', label: 'Reading' },
  { id: 'c', label: 'Tests' },
] as const;

function Harness() {
  const [selected, setSelected] = useState<'a' | 'b' | 'c'>('a');
  return (
    <TabRow
      label="Topic materials"
      tabs={TABS}
      selected={selected}
      onSelect={setSelected}
      panelId="p"
    />
  );
}

describe('TabRow', () => {
  it('A02 exposes a tablist whose selected tab is the only tab stop', () => {
    render(<Harness />);
    expect(screen.getByRole('tablist', { name: 'Topic materials' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Slides' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Reading' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'Reading' })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tab', { name: 'Slides' })).toHaveAttribute('aria-controls', 'p');
  });

  it('A02 arrow keys move selection and focus, wrapping at both ends; Home and End jump', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole('tab', { name: 'Slides' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Reading' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Reading' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Tests' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Slides' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Tests' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Slides' })).toHaveFocus();
  });
});

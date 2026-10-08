import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { type MarginTab, MarginTabs } from './MarginTabs';

afterEach(cleanup);

function Harness() {
  const [tab, setTab] = useState<MarginTab>('notes');
  return (
    <MarginTabs tab={tab} onTab={setTab} count={3}>
      <p>{tab === 'notes' ? 'Notes panel' : 'Discussion panel'}</p>
    </MarginTabs>
  );
}

describe('MarginTabs', () => {
  it('A05 exposes My notes and Discussion as tabs controlling one labelled panel', () => {
    render(<Harness />);
    const notes = screen.getByRole('tab', { name: 'My notes' });
    expect(notes).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Discussion 3' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    const panel = screen.getByRole('tabpanel');
    expect(notes).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', notes.id);
    expect(panel).toHaveTextContent('Notes panel');
  });

  it('A05 arrow keys move to Discussion and show its panel', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole('tab', { name: 'My notes' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Discussion 3' })).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Discussion panel');
  });
});

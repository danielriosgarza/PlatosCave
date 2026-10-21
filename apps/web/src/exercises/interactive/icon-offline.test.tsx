import '@testing-library/jest-dom/vitest';
import type { InteractiveView } from '@parallax/contracts';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Categorize } from './Categorize';
import styles from './Interactive.module.css';

afterEach(cleanup);

/** Every fetch of the icons' path data fails, as it does offline. */
const fetches = vi.hoisted(() => ({ count: 0 }));
vi.mock('./iconPaths.gen', () => {
  fetches.count++;
  throw new Error('offline');
});

const view: Extract<InteractiveView, { kind: 'categorize' }> = {
  kind: 'categorize',
  categories: [
    { id: 'fruit', label: 'Fruit' },
    { id: 'drink', label: 'Drink' },
  ],
  items: [
    { id: 'banana', label: 'Banana', icon: 'banana' },
    { id: 'milk', label: 'Milk', icon: 'milk' },
  ],
  iconsOnly: true,
};
const sort = () => (
  <Categorize
    view={view}
    draft={{ kind: 'categorize', placed: {} }}
    disabled={false}
    onChange={() => {}}
  />
);

describe('the icons’ path data, offline', () => {
  it('A20 a piece shown by its icon alone keeps its label when the icons do not load, and the next exercise tries again', async () => {
    render(sort());
    await waitFor(() => expect(fetches.count).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const piece = screen.getByRole('button', { name: 'Banana' });
    expect(screen.getByText('Banana')).not.toHaveClass(styles.visuallyHidden as string);
    expect(piece.querySelector('svg path')).toBeNull();
    cleanup();
    render(sort());
    await waitFor(() => expect(fetches.count).toBe(2));
    expect(screen.getByText('Milk')).not.toHaveClass(styles.visuallyHidden as string);
  });
});

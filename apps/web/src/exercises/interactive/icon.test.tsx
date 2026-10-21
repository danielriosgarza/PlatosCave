import '@testing-library/jest-dom/vitest';
import type { InteractiveView } from '@parallax/contracts';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Categorize } from './Categorize';
import { Hotspot } from './Hotspot';
import styles from './Interactive.module.css';

afterEach(cleanup);

/** Counts fetches of the icons' path data, and holds each until `open` is called. */
const fetches = vi.hoisted(() => {
  let open = () => {};
  const held = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { count: 0, held, open: () => open() };
});
vi.mock('./iconPaths.gen', async (importOriginal) => {
  fetches.count++;
  await fetches.held;
  return importOriginal();
});

type Sorting = Extract<InteractiveView, { kind: 'categorize' }>;
const sorting = (iconsOnly: boolean): Sorting => ({
  kind: 'categorize',
  categories: [
    { id: 'fruit', label: 'Fruit' },
    { id: 'drink', label: 'Drink' },
  ],
  items: [
    { id: 'banana', label: 'Banana', ...(iconsOnly && { icon: 'banana' }) },
    { id: 'milk', label: 'Milk', ...(iconsOnly && { icon: 'milk' }) },
  ],
  ...(iconsOnly && { iconsOnly: true }),
});
const sort = (view: Sorting) => (
  <Categorize
    view={view}
    draft={{ kind: 'categorize', placed: {} }}
    disabled={false}
    onChange={() => {}}
  />
);

describe('the icons’ path data', () => {
  it('A08 an exercise that draws no icon fetches no icon data', async () => {
    render(sort(sorting(false)));
    render(
      <Hotspot
        view={{
          kind: 'hotspot',
          scene: { x: [0, 4], y: [0, 2], shapes: [{ type: 'circle', center: [1, 1], r: 1 }] },
          multiple: false,
          regions: [
            { id: 'a', label: 'A', shape: { type: 'circle', center: [1, 1], r: 1 } },
            { id: 'b', label: 'B', shape: { type: 'rect', at: [2, 0], size: [1, 1] } },
          ],
        }}
        draft={{ kind: 'hotspot', picked: [] }}
        disabled={false}
        label="Step"
        onChange={() => {}}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetches.count).toBe(0);
  });

  it('A20 a piece shown by its icon alone shows its label until the icon is drawn', async () => {
    render(sort(sorting(true)));
    await waitFor(() => expect(fetches.count).toBe(1));
    expect(styles.visuallyHidden).toBeTruthy();
    const label = () => screen.getByText('Banana');
    // While the icons are on their way, the label is what shows.
    expect(label()).not.toHaveClass(styles.visuallyHidden as string);
    expect(screen.getByRole('button', { name: 'Banana' }).querySelector('svg path')).toBeNull();
    fetches.open();
    await waitFor(
      () =>
        expect(
          screen.getByRole('button', { name: 'Banana' }).querySelector('svg path'),
        ).not.toBeNull(),
      { timeout: 5000 },
    );
    expect(label()).toHaveClass(styles.visuallyHidden as string);
    // Fetched once, for every piece and every later exercise.
    cleanup();
    render(sort(sorting(true)));
    expect(screen.getByRole('button', { name: 'Milk' }).querySelector('svg path')).not.toBeNull();
    expect(fetches.count).toBe(1);
  });
});

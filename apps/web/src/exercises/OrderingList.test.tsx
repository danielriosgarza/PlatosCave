import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { OrderingList } from './OrderingList';

afterEach(cleanup);

const labels = new Map([
  ['a', 'First'],
  ['b', 'Second'],
  ['c', 'Third'],
  ['d', 'Fourth'],
]);

function Harness() {
  const [order, setOrder] = useState(['a', 'b', 'c', 'd']);
  return <OrderingList order={order} labels={labels} disabled={false} onChange={setOrder} />;
}

const shown = () =>
  [...document.querySelectorAll<HTMLElement>('li[data-item]')].map((li) => li.dataset.item);

describe('ordering list', () => {
  it('A08 an item dragged by its grip follows the pointer down past several rows and stays there', () => {
    render(<Harness />);
    // jsdom lays nothing out: each row is 40px tall, and the pointer is over the row now there.
    document.elementFromPoint = (_x, y) =>
      document.querySelectorAll('li[data-item]')[Math.floor(y / 40)] ?? null;
    const pointer = (type: string, y: number) =>
      new PointerEvent(type, { bubbles: true, clientX: 10, clientY: y, pointerId: 1 });
    const grip = document.querySelector('li[data-item="a"] [aria-hidden="true"]');
    if (!grip) throw new Error('no grip');
    act(() => {
      grip.dispatchEvent(pointer('pointerdown', 20));
    });
    expect(document.querySelector('li[data-item="a"]')).toHaveAttribute('data-dragging', 'true');
    // The moves reach the window wherever the pointer is: the grip has moved away under it.
    for (const y of [60, 100, 140]) {
      act(() => {
        window.dispatchEvent(pointer('pointermove', y));
      });
    }
    expect(shown()).toEqual(['b', 'c', 'd', 'a']);
    act(() => {
      window.dispatchEvent(pointer('pointerup', 140));
      window.dispatchEvent(pointer('pointermove', 20));
    });
    expect(shown()).toEqual(['b', 'c', 'd', 'a']);
    expect(document.querySelector('li[data-dragging]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Move First down' })).toBeDisabled();
  });
});

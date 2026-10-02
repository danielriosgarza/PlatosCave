import { expect, test } from 'vitest';
import { BackgroundTasks } from './background';

test('a task that throws before returning a promise is contained and logged', async () => {
  const logged: unknown[] = [];
  const tasks = new BackgroundTasks({ error: (...a: unknown[]) => logged.push(a) } as never);
  expect(() =>
    tasks.run(() => {
      throw new Error('sync failure');
    }),
  ).not.toThrow();
  expect(await tasks.settled()).toBe(0);
  expect(logged).toHaveLength(1);
});

test('settled waits for tasks, including ones started meanwhile', async () => {
  const tasks = new BackgroundTasks();
  const order: string[] = [];
  tasks.run(async () => {
    await new Promise((r) => setTimeout(r, 10));
    tasks.run(async () => void order.push('second'));
    order.push('first');
  });
  expect(await tasks.settled()).toBe(0);
  expect(order).toEqual(['first', 'second']);
});

test('settled gives up at its deadline and reports what is still running', async () => {
  const tasks = new BackgroundTasks();
  let release: () => void = () => {};
  tasks.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  expect(await tasks.settled(20)).toBe(1);
  release();
  expect(await tasks.settled()).toBe(0);
});

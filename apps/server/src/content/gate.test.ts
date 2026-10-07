import { describe, expect, test } from 'vitest';
import { Gate, GateBusy } from './gate';

const deferred = () => {
  let done!: () => void;
  const promise = new Promise<void>((resolve) => {
    done = resolve;
  });
  return { promise, done };
};

describe('Gate', () => {
  test('A10 submission checks past the gate’s size do not run at once and the overflow is refused', async () => {
    const gate = new Gate(2, 1);
    let running = 0;
    let peak = 0;
    const holds = [deferred(), deferred(), deferred()];
    const work = (i: number) => async () => {
      running++;
      peak = Math.max(peak, running);
      await holds[i]?.promise;
      running--;
      return i;
    };
    const first = gate.run(work(0));
    const second = gate.run(work(1));
    const third = gate.run(work(2));
    await new Promise((r) => setTimeout(r, 10));
    expect(running).toBe(2);
    await expect(gate.run(async () => 3)).rejects.toBeInstanceOf(GateBusy);
    holds[0]?.done();
    expect(await first).toBe(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(running).toBe(2);
    holds[1]?.done();
    holds[2]?.done();
    expect([await second, await third]).toEqual([1, 2]);
    expect(peak).toBe(2);
    // Slots are all free again.
    expect(await gate.run(async () => 'ok')).toBe('ok');
  });

  test('A10 a failed check frees its slot for the next', async () => {
    const gate = new Gate(1, 1);
    await expect(
      gate.run(async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(await gate.run(async () => 1)).toBe(1);
  });
});

import { expect, test } from 'vitest';
import { FailureBudget, Throttle, WindowLimit } from './budgets';

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 9, 0) + minutes * 60_000);

test('a failure budget blocks a key for ten minutes after ten failures in ten minutes', () => {
  const budget = new FailureBudget({ max: 10, windowMs: 600_000, blockMs: 600_000 });
  for (let i = 0; i < 9; i++) budget.fail('ip', at(i));
  expect(budget.blocked('ip', at(9))).toBe(false);
  budget.fail('ip', at(9));
  expect(budget.blocked('ip', at(9))).toBe(true);
  expect(budget.blocked('other', at(9))).toBe(false);
  expect(budget.blocked('ip', at(18.9))).toBe(true);
  expect(budget.blocked('ip', at(19))).toBe(false);
});

test('failures older than the window do not count', () => {
  const budget = new FailureBudget({ max: 3, windowMs: 600_000, blockMs: 600_000 });
  budget.fail('ip', at(0));
  budget.fail('ip', at(5));
  budget.fail('ip', at(11));
  expect(budget.blocked('ip', at(11))).toBe(false);
  budget.fail('ip', at(12));
  expect(budget.blocked('ip', at(12))).toBe(true);
});

test('a budget keeps at most maxKeys keys', () => {
  const budget = new FailureBudget({ max: 1, windowMs: 1000, blockMs: 60_000, maxKeys: 2 });
  for (const key of ['a', 'b', 'c']) budget.fail(key, at(0));
  expect(['a', 'b', 'c'].map((k) => budget.blocked(k, at(0)))).toEqual([false, true, true]);
});

test('a throttle allows a key once per interval', () => {
  const throttle = new Throttle(1000);
  const t0 = at(0);
  expect(throttle.allow('c', t0)).toBe(true);
  expect(throttle.allow('c', new Date(t0.getTime() + 999))).toBe(false);
  expect(throttle.allow('d', t0)).toBe(true);
  expect(throttle.allow('c', new Date(t0.getTime() + 1000))).toBe(true);
});

test('a window limit allows a key max times within the window', () => {
  const limit = new WindowLimit({ max: 2, windowMs: 3_600_000 });
  expect([0, 1, 2].map((m) => limit.take('u', at(m)))).toEqual([true, true, false]);
  expect(limit.take('v', at(2))).toBe(true);
  expect(limit.take('u', at(60))).toBe(true);
  expect(limit.take('u', at(61))).toBe(true);
  expect(limit.take('u', at(62))).toBe(false);
});

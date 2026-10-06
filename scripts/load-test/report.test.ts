import { describe, expect, test } from 'vitest';
import { markdown, passed, percentile, summarise } from './report';

describe('load test report', () => {
  test('percentile uses the nearest rank', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNaN();
  });

  test('a p95 over the §14 budget fails, and so does a metric with no samples', () => {
    const over = Array.from({ length: 100 }, (_, i) => (i < 94 ? 100 : 1500));
    const rows = summarise({
      overview: [100],
      start: [100],
      save: over,
      enqueue: [100],
      queueWait: [5],
    });
    expect(rows.find((r) => r.metric === 'save')?.ok).toBe(false);
    expect(rows.find((r) => r.metric === 'overview')?.ok).toBe(true);
    expect(passed(rows, [])).toBe(false);
    expect(summarise({}).every((r) => !r.ok)).toBe(true);
  });

  test('the report lists silent failures and passes only when there are none', () => {
    const ok = { overview: [1], start: [1], save: [1], enqueue: [1], queueWait: [1] };
    const rows = summarise(ok);
    expect(passed(rows, [])).toBe(true);
    expect(passed(rows, ['student 3: run never finished'])).toBe(false);
    const text = markdown(rows, {
      students: 200,
      windowSeconds: 60,
      failures: ['student 3: run never finished'],
      queuePositionSeen: true,
    });
    expect(text).toContain('Silent failures: 1');
    expect(text).toContain('student 3: run never finished');
  });
});

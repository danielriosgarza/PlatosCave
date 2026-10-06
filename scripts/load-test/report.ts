/** Timing statistics and the §14 budget check for the load test; no I/O, so it is unit-tested. */

/** Nearest-rank percentile of `values` (0 < p <= 100); NaN when there are none. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number;
}

export interface Budget {
  /** Key in the samples object. */
  metric: string;
  label: string;
  /** p95 limit in milliseconds, from spec §14; null when §14 sets none and the row only reports. */
  p95Ms: number | null;
}

/** Spec §14 budgets, measured at the API: the 100 ms round trip and laptop rendering are not included. */
export const BUDGETS: Budget[] = [
  { metric: 'overview', label: 'Open the test (course/topic navigation: 2 s)', p95Ms: 2000 },
  { metric: 'start', label: 'Start an attempt', p95Ms: 2000 },
  { metric: 'save', label: 'Answer save acknowledgement (1 s)', p95Ms: 1000 },
  { metric: 'enqueue', label: 'Run sample tests: request acknowledged', p95Ms: 1000 },
  { metric: 'queueWait', label: 'Run sample tests: queued until a result', p95Ms: null },
];

export interface Row {
  metric: string;
  label: string;
  count: number;
  p50: number;
  p95: number;
  max: number;
  budget: number | null;
  ok: boolean;
}

export function summarise(samples: Record<string, number[]>, budgets = BUDGETS): Row[] {
  return budgets.map((b) => {
    const values = samples[b.metric] ?? [];
    const p95 = percentile(values, 95);
    return {
      metric: b.metric,
      label: b.label,
      count: values.length,
      p50: percentile(values, 50),
      p95,
      max: values.length ? Math.max(...values) : Number.NaN,
      budget: b.p95Ms,
      // No samples is a failure: a budget nobody measured has not been met.
      ok: values.length > 0 && (b.p95Ms === null || p95 <= b.p95Ms),
    };
  });
}

const ms = (n: number) => (Number.isNaN(n) ? '–' : `${Math.round(n)} ms`);

export function markdown(
  rows: Row[],
  facts: {
    students: number;
    windowSeconds: number;
    failures: string[];
    queuePositionSeen: boolean;
  },
): string {
  const lines = [
    `Load test: ${facts.students} students starting within ${facts.windowSeconds} s`,
    '',
    '| Measure | n | p50 | p95 | max | §14 p95 budget | |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
    ...rows.map(
      (r) =>
        `| ${r.label} | ${r.count} | ${ms(r.p50)} | ${ms(r.p95)} | ${ms(r.max)} | ${
          r.budget === null ? 'reported only' : ms(r.budget)
        } | ${r.ok ? 'ok' : 'OVER'} |`,
    ),
    '',
    `Queue position shown to a waiting student: ${facts.queuePositionSeen ? 'yes' : 'never observed'}`,
    `Silent failures: ${facts.failures.length}`,
    ...facts.failures.slice(0, 20).map((f) => `- ${f}`),
  ];
  return lines.join('\n');
}

/** Failed when a budget is over, a student ended without a result or a visible queue state. */
export function passed(rows: Row[], failures: string[]): boolean {
  return failures.length === 0 && rows.every((r) => r.ok);
}

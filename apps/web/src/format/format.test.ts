import { describe, expect, test } from 'vitest';
import { ATTEMPT_STATE_LABEL, formatInstant, REPORTED_RULE_LABEL } from './format';

describe('shared formatting', () => {
  test('A20 one instant reads the same on every screen, with the zone named', () => {
    const iso = '2026-10-05T10:00:00.000Z';
    expect(formatInstant(iso, 'UTC')).toBe('05 Oct 2026, 10:00 UTC');
    expect(formatInstant(iso, 'Europe/Amsterdam')).toMatch(/^05 Oct 2026, 12:00 (CEST|GMT\+2)$/);
  });

  test('A20 a needs-review attempt and a reported rule each have one label', () => {
    expect(ATTEMPT_STATE_LABEL.needs_review).toBe('Needs review');
    expect(REPORTED_RULE_LABEL.latest).toBe('latest attempt');
  });
});

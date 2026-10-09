import { describe, expect, test } from 'vitest';
import { formatInstant, points, pointsOf } from './format';

describe('shared formatting', () => {
  test('one instant reads the same on every screen, with the zone named', () => {
    const iso = '2026-10-05T10:00:00.000Z';
    expect(formatInstant(iso, 'UTC')).toBe('05 Oct 2026, 10:00 UTC');
    expect(formatInstant(iso, 'Europe/Amsterdam')).toMatch(/^05 Oct 2026, 12:00 (CEST|GMT\+2)$/);
  });

  test('points read the same for student and instructor, rounded', () => {
    expect(pointsOf(6.666666666666667, 10)).toBe('6.67 of 10 points');
    expect(points(6.666666666666667)).toBe('6.67');
  });
});

import { describe, expect, test } from 'vitest';
import { type Audience, canSee, type Viewer } from './visibility';

const author = 'author';
const student: Viewer = { userId: 'classmate', role: 'student' };
const instructor: Viewer = { userId: 'teacher', role: 'instructor' };
const self: Viewer = { userId: author, role: 'student' };
const row = (audience: Audience, isPreview = false) => ({ authorId: author, audience, isPreview });

describe('audience rule (ADR-0002)', () => {
  test.each([
    ['private', [true, false, false]],
    ['instructor', [true, false, true]],
    ['class', [true, true, true]],
  ] as const)('A05 %s rows: author, classmate, instructor', (audience, [a, s, i]) => {
    expect(canSee(self, row(audience))).toBe(a);
    expect(canSee(student, row(audience))).toBe(s);
    expect(canSee(instructor, row(audience))).toBe(i);
  });

  test('rows written by a preview principal are seen by that principal only', () => {
    for (const audience of ['instructor', 'class'] as const) {
      expect(canSee(self, row(audience, true))).toBe(true);
      expect(canSee(student, row(audience, true))).toBe(false);
      expect(canSee(instructor, row(audience, true))).toBe(false);
    }
  });
});

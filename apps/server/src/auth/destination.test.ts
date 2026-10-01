import { describe, expect, test } from 'vitest';
import { defaultDestination, safeDestination } from './destination';

describe('safeDestination', () => {
  test('keeps same-origin app paths with their query and fragment', () => {
    expect(safeDestination('/classes/abc/topics?tab=reading#p3')).toBe(
      '/classes/abc/topics?tab=reading#p3',
    );
    expect(safeDestination('/courses')).toBe('/courses');
  });

  test.each([
    'https://evil.example/',
    '//evil.example/x',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    'courses',
    '',
    '/x\ny',
    '/\t/evil.example',
    '/api/auth/signout',
    '/api',
    '/..//evil.example',
    '/.//evil.example',
    '/a/..//evil.example/x',
    '/%2e%2e//evil.example',
    `/${'a'.repeat(2048)}`,
  ])('refuses %j', (input) => {
    expect(safeDestination(input)).toBeNull();
  });

  test('percent-encoded sequences stay inert path text on the app origin', () => {
    expect(safeDestination('/%0d%0aSet-Cookie:x')).toBe('/%0d%0aSet-Cookie:x');
  });

  test('refuses non-strings', () => {
    expect(safeDestination(undefined)).toBeNull();
    expect(safeDestination(null)).toBeNull();
    expect(safeDestination(42)).toBeNull();
  });

  test('normalises dot segments without leaving the origin', () => {
    expect(safeDestination('/a/../../b')).toBe('/b');
  });
});

test('each entrance lands on its own view of /courses', () => {
  expect(defaultDestination('instructor')).toBe('/courses?view=instructor');
  expect(defaultDestination('student')).toBe('/courses?view=student');
  expect(defaultDestination(undefined)).toBe('/courses?view=student');
});

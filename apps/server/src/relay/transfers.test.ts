import { describe, expect, test } from 'vitest';
import type { OwnedSession } from '../db/notebooks/sessions';
import { contentRoot } from './transfers';

const session = (runtime: Record<string, unknown>, owned: boolean) =>
  ({ runtime, owned }) as Pick<OwnedSession, 'runtime' | 'owned'>;

describe('contentRoot (P3-09b)', () => {
  test('the root the connector reported is used, empty included', () => {
    expect(contentRoot(session({ mode: 'attach', contentRoot: 'parallax' }, false))).toBe(
      'parallax',
    );
    expect(contentRoot(session({ mode: 'attach', contentRoot: '' }, false))).toBe('');
    expect(contentRoot(session({ mode: 'start', contentRoot: '' }, true))).toBe('');
  });

  test('an owned session started in the workspace without a report is the root itself', () => {
    expect(contentRoot(session({ mode: 'start' }, true))).toBe('');
  });

  test('an attached session without a usable root cannot be placed', () => {
    expect(contentRoot(session({ mode: 'attach' }, false))).toBeUndefined();
    expect(contentRoot(session({ mode: 'start' }, false))).toBeUndefined();
    for (const bad of ['../x', 'a/../b', '.hidden', 'a//b', '/abs', 'a\\b', 7]) {
      expect(contentRoot(session({ mode: 'attach', contentRoot: bad }, false))).toBeUndefined();
    }
  });
});

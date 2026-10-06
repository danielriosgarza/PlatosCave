import { describe, expect, it } from 'vitest';
import { isWellFormed, toWellFormedDeep } from './wellFormed';

describe('well-formed text', () => {
  it('refuses a lone surrogate and accepts a pair', () => {
    expect(isWellFormed('plain')).toBe(true);
    expect(isWellFormed('paired 😀')).toBe(true);
    expect(isWellFormed('half \ud800')).toBe(false);
    expect(isWellFormed('\udc00 half')).toBe(false);
  });

  it('replaces a lone surrogate anywhere in a JSON value, keys included, and drops nothing', () => {
    expect(toWellFormedDeep(['ok', { files: [{ content: 'x = "\ud800"' }] }])).toEqual([
      'ok',
      { files: [{ content: 'x = "\ufffd"' }] },
    ]);
    expect(toWellFormedDeep({ '\ud800': 1 })).toEqual({ '\ufffd': 1 });
    const fine = { a: ['😀', 1, null, true], b: { c: 'fine' } };
    expect(toWellFormedDeep(fine)).toEqual(fine);
    expect(toWellFormedDeep(null)).toBeNull();
  });
});

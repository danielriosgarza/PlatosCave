import { describe, expect, it } from 'vitest';
import { hasLoneSurrogate, isWellFormed } from './wellFormed';

describe('well-formed text', () => {
  it('refuses a lone surrogate and accepts a pair', () => {
    expect(isWellFormed('plain')).toBe(true);
    expect(isWellFormed('paired 😀')).toBe(true);
    expect(isWellFormed('half \ud800')).toBe(false);
    expect(isWellFormed('\udc00 half')).toBe(false);
  });

  it('finds a lone surrogate anywhere in a JSON value, keys included', () => {
    expect(hasLoneSurrogate(['ok', { files: [{ content: 'x = "\ud800"' }] }])).toBe(true);
    expect(hasLoneSurrogate({ '\ud800': 1 })).toBe(true);
    expect(hasLoneSurrogate({ a: ['😀', 1, null, true], b: { c: 'fine' } })).toBe(false);
    expect(hasLoneSurrogate(null)).toBe(false);
  });
});

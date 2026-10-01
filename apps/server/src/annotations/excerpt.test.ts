import { describe, expect, test } from 'vitest';
import { excerpt } from './annotations';

describe('notification excerpts', () => {
  test('short bodies are kept whole', () => {
    expect(excerpt('Why n − 1?')).toBe('Why n − 1?');
    expect(excerpt('a'.repeat(140))).toBe('a'.repeat(140));
  });

  test('long bodies are cut on whole characters, never inside a surrogate pair', () => {
    const cut = excerpt(`a${'😀'.repeat(200)}`);
    expect(cut).toBe(`a${'😀'.repeat(138)}…`);
    // In a /u pattern a whole pair is one code point, so only a lone surrogate matches.
    expect(/\p{Cs}/u.test(cut)).toBe(false);
  });
});

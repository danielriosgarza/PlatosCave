import { createHmac } from 'node:crypto';
import { PAIRING_CODE_PATTERN } from '@parallax/contracts';
import { describe, expect, test } from 'vitest';
import { hashPairingCode, newPairingCode, normalisePairingCode, pairingKey } from './pairing';

describe('pairing codes', () => {
  test('are eight Crockford base 32 symbols shown as XXXX-XXXX', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const code = newPairingCode();
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      expect(normalisePairingCode(code)).toMatch(PAIRING_CODE_PATTERN);
      seen.add(code);
    }
    // 40 bits: 500 draws do not collide in practice.
    expect(seen.size).toBe(500);
  });

  test.each([
    ['K7M2-Q9XD', 'K7M2Q9XD'],
    ['k7m2 q9xd', 'K7M2Q9XD'],
    ['OOOO-oooo', '00000000'],
    ['IiLl-1111', '11111111'],
    ['  ab cd-ef gh ', 'ABCDEFGH'],
  ])('normalises %j to %s', (input, want) => {
    expect(normalisePairingCode(input)).toBe(want);
  });

  test.each(['K7M2-Q9X', 'K7M2-Q9XDE', 'K7M2-Q9XU', 'K7M2_Q9XD', '', 'K7M2-Q9X!'])(
    'refuses %j',
    (input) => {
      expect(normalisePairingCode(input)).toBeNull();
    },
  );

  test('the stored hash is HMAC-SHA256(HMAC-SHA256(SESSION_SECRET, label), code)', () => {
    const secret = 'a-session-secret-of-at-least-32-characters';
    const key = createHmac('sha256', secret).update('parallax-pairing-v1').digest();
    expect(pairingKey(secret)).toEqual(key);
    const want = createHmac('sha256', key).update('K7M2Q9XD').digest();
    expect(hashPairingCode(pairingKey(secret), 'K7M2Q9XD')).toEqual(want);
    // The normalised spelling is what is hashed, so O and 0 reach the same row.
    const typed = normalisePairingCode('K7M2-Q9XO') as string;
    expect(hashPairingCode(key, typed)).toEqual(hashPairingCode(key, 'K7M2Q9X0'));
    // Another deployment's secret gives another hash.
    expect(hashPairingCode(pairingKey(`${secret}!`), 'K7M2Q9XD')).not.toEqual(want);
  });
});

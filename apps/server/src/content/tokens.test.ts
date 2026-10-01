import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  type ContentGrant,
  MAX_TOKEN_LENGTH,
  mintContentToken,
  verifyContentToken,
} from './tokens';

const secret = 'x'.repeat(32);
const course = '00000000-0000-4000-8000-000000000101';
const other = '00000000-0000-4000-8000-000000000102';
const grant: ContentGrant = {
  key: `courses/${course}/objects/${'a'.repeat(64)}`,
  userId: '00000000-0000-4000-8000-000000000004',
  scopeId: course,
  contentType: 'application/pdf',
  disposition: 'inline',
};
const now = new Date('2026-10-01T09:00:00Z');
const later = (s: number) => new Date(now.getTime() + s * 1000);

describe('content tokens', () => {
  test('round-trip: a fresh token yields its claims and expires after five minutes', () => {
    const { token, exp } = mintContentToken(secret, grant, now);
    expect(exp).toBe(now.getTime() / 1000 + 300);
    expect(verifyContentToken(secret, token, later(299))).toMatchObject({ ...grant, exp });
    expect(verifyContentToken(secret, token, later(300))).toBeNull();
  });

  test('A01 tampered, re-signed with another key or malformed tokens are refused', () => {
    const { token } = mintContentToken(secret, grant, now);
    const [payload, mac] = token.split('.') as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ ...grant, key: `courses/${other}/objects/${'b'.repeat(64)}`, exp: 2e9 }),
    ).toString('base64url');
    for (const bad of [
      `${forged}.${mac}`,
      `${payload}.${mac.slice(0, -2)}AA`,
      `${payload}.`,
      payload,
      `${token}.x`,
      '',
    ]) {
      expect(verifyContentToken(secret, bad, now), bad).toBeNull();
    }
    expect(verifyContentToken('y'.repeat(32), token, now)).toBeNull();
  });

  test('A01 correctly signed payloads that are not claim objects are refused, not thrown on', () => {
    for (const json of ['null', '42', '[]', '"x"', '{}']) {
      const payload = Buffer.from(json).toString('base64url');
      const mac = createHmac('sha256', secret).update(payload).digest('base64url');
      expect(verifyContentToken(secret, `${payload}.${mac}`, now), json).toBeNull();
    }
  });

  test('minting refuses a token longer than the content route accepts', () => {
    const filename = 'x'.repeat(MAX_TOKEN_LENGTH);
    expect(() => mintContentToken(secret, { ...grant, filename }, now)).toThrow(/too long/);
  });

  test('A21 tokens are only minted for keys under the scope’s own prefix', () => {
    const outside = [
      `courses/${other}/objects/${'a'.repeat(64)}`,
      `classes/${other}/objects/${'a'.repeat(64)}`,
      `courses/${course}`,
      `courses/${course}/../x`,
    ];
    for (const key of outside) {
      expect(() => mintContentToken(secret, { ...grant, key }, now), key).toThrow();
    }
    expect(() =>
      mintContentToken(secret, { ...grant, key: `classes/${course}/exports/a` }, now),
    ).not.toThrow();
  });

  test('content types that could inject headers are refused', () => {
    for (const contentType of ['text/html\r\nset-cookie: a=b', 'pdf', '']) {
      expect(() => mintContentToken(secret, { ...grant, contentType }, now)).toThrow();
    }
  });
});

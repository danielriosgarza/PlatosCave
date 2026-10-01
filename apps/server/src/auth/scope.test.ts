import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { expect, test } from 'vitest';
import { assertRecentAuth, RECENT_AUTH_MS } from './scope';
import { readSessionToken, sessionCookieHeader } from './sessions';

test('recent authentication is required within 15 minutes', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  expect(() => assertRecentAuth(new Date(now.getTime() - RECENT_AUTH_MS), now)).not.toThrow();
  expect(() => assertRecentAuth(new Date(now.getTime() - RECENT_AUTH_MS - 1), now)).toThrow(
    expect.objectContaining({ statusCode: 401, code: 'recent_auth_required' }),
  );
});

test('the session token is read from the signed pc_session cookie only', async () => {
  const secret = 'a'.repeat(32);
  const app = Fastify();
  await app.register(cookie, { secret });
  app.get('/t', async (req) => ({ token: readSessionToken(req) ?? null }));
  const tokenFor = async (header?: string) =>
    (await app.inject({ url: '/t', headers: header ? { cookie: header } : {} })).json().token;

  expect(await tokenFor(`a=1; ${sessionCookieHeader('tok', secret)}; b=2`)).toBe('tok');
  // Unsigned, tampered, signed with another secret, wrong name, empty or missing: no token.
  expect(await tokenFor('pc_session=tok')).toBeNull();
  expect(await tokenFor(sessionCookieHeader('tok', secret).replace('tok', 'other'))).toBeNull();
  expect(await tokenFor(sessionCookieHeader('tok', 'b'.repeat(32)))).toBeNull();
  expect(await tokenFor(`x${sessionCookieHeader('tok', secret)}`)).toBeNull();
  expect(await tokenFor('pc_session=')).toBeNull();
  expect(await tokenFor()).toBeNull();
  await app.close();
});

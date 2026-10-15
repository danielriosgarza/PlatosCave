import { count } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { authSessions } from '../../src/db/schema';
import * as idp from '../fixtures/oidc-issuer';
import { buildWorld, issueLiveInvites } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

const now = new Date('2026-10-14T09:00:00Z');
const issuer = idp.createIssuer();
let testDb: TestDatabase;
const apps: FastifyInstance[] = [];

async function makeApp(env: Record<string, string> = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    APP_ORIGIN: 'https://parallax.example.org',
    ...idp.providerEnv(idp.UNIVERSITY),
    ...env,
  });
  const deps = { db: testDb.db, now: () => now, identityFetch: issuer.fetch };
  const instance = await buildApp(config, deps);
  apps.push(instance);
  return instance;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await buildWorld(testDb.db, now);
});

afterAll(async () => {
  for (const a of apps) await a.close();
  await testDb?.drop();
});

describe('provider sign-in guards', () => {
  test('an issuer that cannot be reached sends the browser back to the sign-in page and is asked again', async () => {
    const fresh = await makeApp();
    issuer.unreachable = true;
    const failed = await idp.startSignIn(fresh, issuer).finally(() => {
      issuer.unreachable = false;
    });
    expect(failed.start.statusCode).toBe(302);
    expect(failed.start.headers.location).toBe('/signin?provider=university&refused=failed');
    expect(failed.start.cookies).toEqual([]);
    const again = await idp.startSignIn(fresh, issuer);
    expect(String(again.start.headers.location)).toMatch(`${idp.ISSUER}/authorize?`);
  });

  test('INSTRUCTOR_EMAILS and invitations work for an account reached through a provider', async () => {
    const teaching = await makeApp({ INSTRUCTOR_EMAILS: ' Ana@Example.org ' });
    const { session } = await idp.signInThroughIssuer(teaching, issuer);
    const send = (url: string, payload: object) =>
      teaching.inject({ method: 'POST', url, payload, headers: { cookie: session } });
    expect((await send('/api/courses', { title: 'Provider course' })).statusCode).toBe(200);
    const { instructorToken } = await issueLiveInvites(testDb.db, now, 'ana@example.org');
    const accepted = await send('/api/invitations/accept', { token: instructorToken });
    expect(accepted.json()).toMatchObject({ role: 'instructor' });
  });

  test('an issuer that refuses the sign-in sends the browser back to the sign-in page and starts no session', async () => {
    const declined = await makeApp();
    const sessions = async () => (await testDb.db.select({ n: count() }).from(authSessions))[0]?.n;
    const before = await sessions();
    const { start, pending } = await idp.startSignIn(declined, issuer, { next: '/courses' });
    expect(pending).toBeDefined();
    // The person pressed Cancel at the issuer: it sends the browser back with an error, no code.
    const authorize = new URL(String(start.headers.location));
    const back = new URL(String(authorize.searchParams.get('redirect_uri')));
    back.searchParams.set('error', 'access_denied');
    back.searchParams.set('state', String(authorize.searchParams.get('state')));
    const callback = await idp.finishSignIn(declined, back, [pending]);
    expect(callback.statusCode).toBe(302);
    const to = '/signin?provider=university&refused=failed&next=%2Fcourses';
    expect(callback.headers.location).toBe(to);
    expect(callback.cookies.find((c) => c.name === 'pc_oidc')?.value).toBe('');
    expect(idp.cookieOf(callback, 'pc_session')).toBeUndefined();
    expect(await sessions()).toBe(before);
  });
});

import { Writable } from 'node:stream';
import { count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { hashToken } from '../../src/auth/tokens';
import { loadConfig } from '../../src/config';
import { userForVerifiedEmail } from '../../src/db/auth/accounts';
import { createSession } from '../../src/db/auth/sessions';
import { authSessions, signinTokens, users } from '../../src/db/schema';
import * as idp from '../fixtures/oidc-issuer';
import { cookieFor } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

const APP_ORIGIN = 'https://parallax.example.org';
const start = new Date('2026-10-14T09:00:00Z');
let clock = start;
let testIndex = 0;
const issuer = idp.createIssuer();
let testDb: TestDatabase;
const apps: FastifyInstance[] = [];
let app: FastifyInstance;
let twoProviders: FastifyInstance;

async function makeApp(env: Record<string, string> = {}, logStream?: Writable) {
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    APP_ORIGIN,
    AUTH_LINK_RATE_LIMIT: '1000',
    AUTH_VERIFY_RATE_LIMIT: '1000',
    ...idp.providerEnv(idp.UNIVERSITY),
    ...env,
  });
  const deps = { db: testDb.db, now: () => clock, identityFetch: issuer.fetch, logStream };
  const instance = await buildApp(config, deps);
  apps.push(instance);
  return instance;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  app = await makeApp();
  twoProviders = await makeApp(idp.providerEnv(idp.UNIVERSITY, idp.HOSPITAL));
});

afterAll(async () => {
  for (const a of apps) await a.close();
  await testDb?.drop();
});

beforeEach(() => {
  testIndex += 1;
  clock = new Date(start.getTime() + testIndex * 3_600_000);
});

const signIn = (o: idp.SignInOptions = {}, on = app) => idp.signInThroughIssuer(on, issuer, o);
const startAt = (o: idp.SignInOptions = {}, on = app) => idp.startSignIn(on, issuer, o);
const rows = async (table: typeof users | typeof authSessions | typeof signinTokens) =>
  (await testDb.db.select({ n: count() }).from(table))[0]?.n;
const counts = async () => ({ users: await rows(users), sessions: await rows(authSessions) });
const sessionOf = async (token: string) =>
  (await testDb.db.select().from(authSessions)).find((s) => s.tokenHash === hashToken(token));
const failed = /^\/signin\?provider=university&refused=failed/;

describe('A47 sign-in providers, server', () => {
  test('A47 signing in with a configured provider reaches the account of the same verified address', async () => {
    const anaId = await userForVerifiedEmail(testDb.db, 'ana@example.org');
    const earlier = await createSession(testDb.db, anaId, { now: new Date(clock.getTime() - 1) });
    const before = await rows(users);
    const { start, callback, session } = await signIn({
      next: '/classes/demo?tab=topics',
      cookie: cookieFor(earlier.token),
      grant: { claims: { email: 'Ana@Example.ORG' } },
    });

    expect(start.statusCode).toBe(302);
    const authorize = new URL(String(start.headers.location));
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${idp.ISSUER}/authorize`);
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      response_type: 'code',
      scope: 'openid email',
      code_challenge_method: 'S256',
      state: expect.stringMatching(/.{16,}/),
      nonce: expect.stringMatching(/.{16,}/),
      redirect_uri: `${APP_ORIGIN}/api/auth/oidc/university/callback`,
    });
    const pending = start.cookies.find((c) => c.name === 'pc_oidc');
    expect(pending).toMatchObject({ httpOnly: true, sameSite: 'Lax', secure: true });
    expect(pending).toMatchObject({ path: '/api/auth/oidc', maxAge: 600 });

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/classes/demo?tab=topics');
    const set = callback.cookies.find((c) => c.name === 'pc_session');
    expect(set).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(callback.cookies.find((c) => c.name === 'pc_oidc')?.value).toBe('');
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: session } });
    expect(me.json().user.id).toBe(anaId);
    expect(await rows(users)).toBe(before);
    // The signed cookie is `<token>.<signature>`.
    const fresh = await sessionOf(String(set?.value).replace(/\.[^.]*$/, ''));
    expect(fresh).toMatchObject({ userId: anaId, authTime: clock, revokedAt: null });
    expect((await sessionOf(earlier.token))?.revokedAt).toEqual(clock);
  });

  test.for([
    ['no email', { email: undefined }],
    ['email_verified missing', { email_verified: undefined }],
    ['email_verified false', { email_verified: false }],
    ['email_verified the string "true"', { email_verified: 'true' }],
    ['an email that is not an address', { email: 'ana at example.org' }],
  ] as const)(
    'A47 an assertion without a verified address is refused and signs nobody in: %s',
    async ([, claims]) => {
      const before = await counts();
      const grant = { claims: { email: 'new.person@example.org', ...claims } };
      const { callback, session } = await signIn({ next: '/courses', grant });
      expect(callback.statusCode).toBe(302);
      const to = '/signin?provider=university&refused=unverified&next=%2Fcourses';
      expect(callback.headers.location).toBe(to);
      expect(session).toBeUndefined();
      expect(await counts()).toEqual(before);
    },
  );

  test('A47 with no mail sender no link is accepted, the methods say so, and a provider still signs people in', async () => {
    const noMail = await makeApp({ MAIL_TRANSPORT: 'none' });
    const payload = { email: 'ana@example.org' };
    const link = await noMail.inject({ method: 'POST', url: '/api/auth/link', payload });
    expect(link.statusCode).toBe(503);
    expect(await rows(signinTokens)).toBe(0);
    const methods = await noMail.inject({ method: 'GET', url: '/api/auth/methods' });
    const university = { id: 'university', name: 'Example University' };
    expect(methods.json()).toEqual({ email: false, providers: [university] });
    expect((await signIn({}, noMail)).session).toBeDefined();
  });

  test('A47 the list of sign-in methods names each configured provider and no secret', async () => {
    const listed = await twoProviders.inject({ method: 'GET', url: '/api/auth/methods' });
    const providers = [idp.UNIVERSITY, idp.HOSPITAL].map(({ id, name }) => ({ id, name }));
    expect(listed.json()).toEqual({ email: true, providers });
    for (const hidden of ['issuer.example.test', idp.CLIENT.id, idp.CLIENT.secret]) {
      expect(listed.body).not.toContain(hidden);
    }
    const none = await makeApp({ OIDC_PROVIDERS: '', OIDC_CLIENT_SECRETS: '' });
    const empty = await none.inject({ method: 'GET', url: '/api/auth/methods' });
    expect(empty.json()).toEqual({ email: true, providers: [] });
  });
});

describe('provider sign-in refusals', () => {
  type Back = { back?: URL; pending?: string };
  const replay =
    (on: FastifyInstance, { back }: Back, cookies: (string | undefined)[]) =>
    () =>
      idp.finishSignIn(on, back as URL, cookies);
  const exchange = (grant: idp.Grant) => async () => {
    const started = await startAt({ grant });
    return replay(app, started, [started.pending]);
  };
  const now = () => Math.floor(Date.now() / 1000);

  test.for([
    ['signed by a key outside the issuer set', exchange({ key: 'stranger' })],
    ['alg none', exchange({ alg: 'none' })],
    ['another iss', exchange({ claims: { iss: 'https://other.example.test' } })],
    ['another aud', exchange({ claims: { aud: 'another-client' } })],
    ['exp in the past', exchange({ claims: { iat: now() - 900, exp: now() - 600 } })],
    ['another nonce', exchange({ claims: { nonce: 'another-nonce' } })],
    ['no pc_oidc cookie', async () => replay(app, await startAt(), [])],
    [
      'a pc_oidc cookie whose signature fails',
      async () => {
        const started = await startAt();
        return replay(app, started, [started.pending?.replace(/\.[^.]*$/, '.forged')]);
      },
    ],
    [
      'the state of another start',
      async () => replay(app, await startAt(), [(await startAt()).pending]),
    ],
    [
      'a pc_oidc cookie set by a start at another provider',
      async () => {
        const other = await startAt({ provider: 'hospital' }, twoProviders);
        const back = new URL(String(other.back).replace('/hospital/', '/university/'));
        return replay(twoProviders, { back }, [other.pending]);
      },
    ],
    [
      'a pc_oidc cookie from a start more than ten minutes earlier',
      async () => {
        const started = await startAt();
        clock = new Date(clock.getTime() + 11 * 60_000);
        return replay(app, started, [started.pending]);
      },
    ],
    [
      'a code used a second time',
      async () => {
        const first = await signIn();
        expect(first.session).toBeDefined();
        return replay(app, first, [first.pending]);
      },
    ],
  ] as const)(
    'a callback that the browser did not start, or an ID token the issuer did not issue, is refused: %s',
    async ([, setUp]) => {
      const callback = await setUp();
      const sessions = await rows(authSessions);
      const res = await callback();
      expect(res.statusCode).toBe(302);
      expect(String(res.headers.location)).toMatch(failed);
      expect(idp.cookieOf(res, 'pc_session')).toBeUndefined();
      expect(await rows(authSessions)).toBe(sessions);
    },
  );

  test('a destination that is not a same-origin path lands on the entrance default page', async () => {
    for (const [next, landing = '/courses?view=instructor'] of [
      ['https://evil.example.org/x'],
      ['//evil.example.org'],
      ['/api/me'],
      ['/classes/x?tab=1#a', '/classes/x?tab=1#a'],
    ]) {
      const { callback } = await signIn({ next, entrance: 'instructor' });
      expect(callback.headers.location, next).toBe(landing);
    }
  });

  test('a deactivated account is refused like a sign-in that did not finish', async () => {
    const id = await userForVerifiedEmail(testDb.db, 'dee@example.org');
    await testDb.db.update(users).set({ deactivatedAt: clock }).where(eq(users.id, id));
    const { callback, session } = await signIn({ grant: { claims: { email: 'dee@example.org' } } });
    expect(String(callback.headers.location)).toMatch(failed);
    expect(session).toBeUndefined();
  });

  test('a provider id that is not configured answers the shared 404 at start and callback', async () => {
    for (const url of ['/api/auth/oidc/nobody/start', '/api/auth/oidc/nobody/callback?code=x']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toEqual({ error: 'not found' });
    }
  });

  test('the request log holds neither the code nor the state of a callback', async () => {
    let log = '';
    const stream = new Writable({
      write(chunk, _enc, done) {
        log += chunk;
        done();
      },
    });
    const { back, session } = await signIn({}, await makeApp({ LOG_LEVEL: 'info' }, stream));
    expect(session).toBeDefined();
    expect(log).toContain('/api/auth/oidc/university/callback?code=[redacted]&state=[redacted]');
    expect(log).not.toContain(String(back.searchParams.get('code')));
    expect(log).not.toContain(String(back.searchParams.get('state')));
  });
});

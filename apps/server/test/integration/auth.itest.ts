import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { count, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { EmailLinkProvider } from '../../src/auth/email-provider';
import { hashToken } from '../../src/auth/sessions';
import { BackgroundTasks } from '../../src/background';
import { loadConfig } from '../../src/config';
import { createSession } from '../../src/db/auth/sessions';
import {
  authSessions,
  classMemberships,
  courseMemberships,
  signinTokens,
  users,
} from '../../src/db/schema';
import { buildWorld, cookieFor, ids, type World } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

const start = new Date('2026-10-01T09:00:00Z');
const APP_ORIGIN = 'http://app.parallax.test';
/** Each test runs in its own hour, so per-address link limits never carry over between tests. */
let t0 = start;
let clock = start;
let testIndex = 0;

/** Mail goes out after the 202; every app here shares this so tests can wait for it. */
const background = new BackgroundTasks();

let testDb: TestDatabase;
let world: World;
let mailDir: string;
const apps: FastifyInstance[] = [];
let app: FastifyInstance;

async function makeApp(env: Record<string, string> = {}): Promise<FastifyInstance> {
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    APP_ORIGIN,
    MAIL_DIR: mailDir,
    AUTH_LINK_RATE_LIMIT: '1000',
    AUTH_VERIFY_RATE_LIMIT: '1000',
    ...env,
  });
  const instance = await buildApp(config, { db: testDb.db, now: () => clock, background });
  await instance.ready();
  apps.push(instance);
  return instance;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, start);
  mailDir = await mkdtemp(join(tmpdir(), 'parallax-auth-mail-'));
  app = await makeApp();
});

afterAll(async () => {
  for (const a of apps) await a.close();
  await testDb?.drop();
  if (mailDir) await rm(mailDir, { recursive: true, force: true });
});

beforeEach(() => {
  testIndex += 1;
  t0 = new Date(start.getTime() + testIndex * 3_600_000);
  clock = t0;
});

interface Mail {
  to: string;
  subject: string;
  text: string;
}

async function mailsTo(email: string): Promise<Mail[]> {
  const files = (await readdir(mailDir)).filter((f) => f.endsWith('.json')).sort();
  const all = await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(join(mailDir, f), 'utf8')) as Mail),
  );
  return all.filter((m) => m.to === email);
}

/** Answers once the request has been answered and any mail it queued has been delivered. */
async function requestLink(body: Record<string, unknown>, instance = app) {
  const res = await instance.inject({ method: 'POST', url: '/api/auth/link', payload: body });
  await background.settled();
  return res;
}

/** Requests a link and returns the verify path from the newest email to that address. */
async function linkFor(email: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await requestLink({ email, ...extra });
  expect(res.statusCode).toBe(202);
  const latest = (await mailsTo(email.toLowerCase())).at(-1);
  if (!latest) throw new Error(`no mail to ${email}`);
  const url = latest.text.match(/https?:\/\/\S+/)?.[0];
  if (!url) throw new Error('no link in mail');
  const parsed = new URL(url);
  expect(parsed.origin).toBe(APP_ORIGIN);
  return `${parsed.pathname}${parsed.search}`;
}

const verify = (path: string, cookie?: string) =>
  app.inject({ method: 'GET', url: path, headers: cookie ? { cookie } : {} });

/** The Cookie request header a browser would send back for a Set-Cookie response. */
function sessionCookieFrom(res: { cookies: { name: string; value: string }[] }): string {
  const c = res.cookies.find((x) => x.name === 'pc_session');
  if (!c?.value) throw new Error('no session cookie set');
  return `pc_session=${encodeURIComponent(c.value)}`;
}

const me = (cookie: string) => app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });

async function membershipCounts(userId: string) {
  const [cls] = await testDb.db
    .select({ n: count() })
    .from(classMemberships)
    .where(eq(classMemberships.userId, userId));
  const [crs] = await testDb.db
    .select({ n: count() })
    .from(courseMemberships)
    .where(eq(courseMemberships.userId, userId));
  return { classes: cls?.n, courses: crs?.n };
}

describe('A01 sign-in route does not grant role', () => {
  test('A01 a student signing in through the instructor entrance keeps only student access', async () => {
    const before = await membershipCounts(ids.sam);
    const res = await verify(await linkFor('sam@example.test', { entrance: 'instructor' }));
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/courses?view=instructor');
    const cookie = sessionCookieFrom(res);

    expect(await membershipCounts(ids.sam)).toEqual(before);
    const body = (await me(cookie)).json();
    expect(body.user.id).toBe(ids.sam);
    expect(body.classes).toEqual([
      expect.objectContaining({ classId: ids.classA, role: 'student' }),
    ]);
    expect(body.courses).toEqual([]);
    const cls = await app.inject({
      method: 'GET',
      url: `/api/classes/${ids.classA}`,
      headers: { cookie },
    });
    expect(cls.json()).toMatchObject({ role: 'student' });
    // Instructor and classmate data stay out of reach: class B is another cohort.
    const other = await app.inject({
      method: 'GET',
      url: `/api/classes/${ids.classB}`,
      headers: { cookie },
    });
    expect(other.statusCode).toBe(404);
  });

  test('A01 a first sign-in through the instructor entrance creates an account with no memberships', async () => {
    const res = await verify(await linkFor('New.Person@Example.test', { entrance: 'instructor' }));
    expect(res.statusCode).toBe(302);
    const body = (await me(sessionCookieFrom(res))).json();
    expect(body.user).toMatchObject({ email: 'new.person@example.test', kind: 'user' });
    expect(body.classes).toEqual([]);
    expect(body.courses).toEqual([]);
    expect(await membershipCounts(body.user.id)).toEqual({ classes: 0, courses: 0 });
  });
});

describe('POST /api/auth/link', () => {
  test('answers 202 with the same body for known and unknown addresses', async () => {
    const known = await requestLink({ email: 'bea@example.test' });
    const unknown = await requestLink({ email: 'nobody-yet@example.test' });
    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(known.json()).toEqual({ accepted: true });
    expect(unknown.body).toBe(known.body);
    // No account is created before the address is proved.
    const rows = await testDb.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'nobody-yet@example.test'));
    expect(rows).toEqual([]);
  });

  test('rejects a malformed address', async () => {
    expect((await requestLink({ email: 'not-an-email' })).statusCode).toBe(400);
  });

  test('the mail names the expiry and links to the app origin', async () => {
    await linkFor('bea@example.test');
    const mail = (await mailsTo('bea@example.test')).at(-1);
    expect(mail?.subject).toBe('Sign in to Parallax');
    expect(mail?.text).toContain('expires in 15 minutes');
    expect(mail?.text).toContain(`${APP_ORIGIN}/api/auth/verify?token=`);
  });

  test('is rate limited per client', async () => {
    const limited = await makeApp({ AUTH_LINK_RATE_LIMIT: '3' });
    for (let i = 0; i < 3; i++) {
      expect((await requestLink({ email: `rl${i}@example.test` }, limited)).statusCode).toBe(202);
    }
    const res = await requestLink({ email: 'rl9@example.test' }, limited);
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: 'too many requests' });
    expect(await mailsTo('rl9@example.test')).toEqual([]);
  });

  test('answers 202 before the mail is delivered, and a hanging relay holds nothing', async () => {
    let release: () => void = () => {};
    const sent: string[] = [];
    const slow = await buildApp(
      loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', AUTH_LINK_RATE_LIMIT: '1000' }),
      {
        db: testDb.db,
        now: () => clock,
        background,
        mailer: {
          send: async (m) => {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            sent.push(m.to);
          },
        },
      },
    );
    apps.push(slow);
    const email = 'slow@example.test';
    const res = await slow.inject({ method: 'POST', url: '/api/auth/link', payload: { email } });
    expect(res.statusCode).toBe(202);
    expect(sent).toEqual([]);
    const [stored] = await testDb.db
      .select()
      .from(signinTokens)
      .where(eq(signinTokens.email, email));
    expect(stored).toBeDefined();
    release();
    await background.settled();
    expect(sent).toEqual([email]);
  });

  test('a delivery failure that cannot remove its row either still answered 202 and is logged without the address', async () => {
    const email = 'both-down@example.test';
    const logged: unknown[] = [];
    const provider = new EmailLinkProvider({
      db: testDb.db,
      now: () => clock,
      background,
      appOrigin: APP_ORIGIN,
      log: { info() {}, error: (...args: unknown[]) => void logged.push(args) } as never,
      mailer: {
        send: async () => {
          // What nodemailer attaches to a rejected send.
          // Relays echo the address in their own case, or just its local part.
          throw Object.assign(
            new Error('550 5.1.1 <Both-Down@Example.test> no such user both-down (both-down).'),
            {
              code: 'EENVELOPE',
              responseCode: 550,
              envelope: { to: [email] },
              rejected: [email],
            },
          );
        },
      },
    });
    // The database fails alongside the mail transport: the compensating delete is refused.
    await testDb.db.execute(
      sql`create function pc_refuse_delete() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end $$`,
    );
    await testDb.db.execute(
      sql`create trigger pc_refuse_delete before delete on signin_tokens for each row execute function pc_refuse_delete()`,
    );
    try {
      await expect(provider.begin({ email, destination: '/courses' })).resolves.toBeUndefined();
      await expect(background.settled()).resolves.toBe(0);
    } finally {
      await testDb.db.execute(sql`drop trigger pc_refuse_delete on signin_tokens`);
      await testDb.db.execute(sql`drop function pc_refuse_delete()`);
    }
    expect(logged).toHaveLength(2);
    expect(JSON.stringify(logged).toLowerCase()).not.toContain('both-down');
    // The diagnostic stays readable.
    expect(JSON.stringify(logged)).toContain('no such user');
    expect(JSON.stringify(logged)).toContain('EENVELOPE');
  });

  test('an undelivered link does not use up one of the address’s five sends', async () => {
    let failing = true;
    const sent: string[] = [];
    const flaky = await buildApp(
      loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', AUTH_LINK_RATE_LIMIT: '1000' }),
      {
        db: testDb.db,
        now: () => clock,
        background,
        mailer: {
          send: async (m) => {
            if (failing) throw new Error('smtp down');
            sent.push(m.to);
          },
        },
      },
    );
    apps.push(flaky);
    const email = 'outage@example.test';
    for (let i = 0; i < 6; i++) expect((await requestLink({ email }, flaky)).statusCode).toBe(202);
    failing = false;
    expect((await requestLink({ email }, flaky)).statusCode).toBe(202);
    expect(sent).toEqual([email]);
  });

  test('concurrent requests for one address still send at most five links', async () => {
    const email = 'burst@example.test';
    const results = await Promise.all(Array.from({ length: 20 }, () => requestLink({ email })));
    expect(results.every((r) => r.statusCode === 202)).toBe(true);
    expect(await mailsTo(email)).toHaveLength(5);
  });

  test('sends at most five links per address per 15 minutes, still answering 202', async () => {
    const email = 'flood@example.test';
    for (let i = 0; i < 7; i++) expect((await requestLink({ email })).statusCode).toBe(202);
    expect(await mailsTo(email)).toHaveLength(5);
    clock = new Date(t0.getTime() + 15 * 60_000 + 1);
    await requestLink({ email });
    expect(await mailsTo(email)).toHaveLength(6);
  });
});

describe('GET /api/auth/verify', () => {
  test('starts a session with auth_time now and a signed HttpOnly SameSite=Lax cookie', async () => {
    const res = await verify(await linkFor('bea@example.test'));
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/courses?view=student');
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/^pc_session=/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('Secure'); // http origin in tests
    const cookie = sessionCookieFrom(res);
    expect((await me(cookie)).json().user.id).toBe(ids.bea);
    // A cookie without the server's signature is refused even if it carries a real token.
    const raw = decodeURIComponent(cookie.slice('pc_session='.length));
    const unsigned = raw.slice(0, raw.lastIndexOf('.'));
    expect((await me(`pc_session=${unsigned}`)).statusCode).toBe(401);

    const sessions = await testDb.db
      .select({ authTime: authSessions.authTime })
      .from(authSessions)
      .where(eq(authSessions.userId, ids.bea));
    expect(sessions.map((s) => s.authTime.toISOString())).toContain(t0.toISOString());
  });

  test('sets Secure on the cookie when the app is served over https', async () => {
    const secure = await makeApp({ APP_ORIGIN: 'https://parallax.example.org' });
    await requestLink({ email: 'sam@example.test' }, secure);
    const url = new URL(
      (await mailsTo('sam@example.test')).at(-1)?.text.match(/https?:\/\/\S+/)?.[0] ?? '',
    );
    const res = await secure.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
    expect(String(res.headers['set-cookie'])).toContain('Secure');
  });

  test('a HEAD request does not use up the link', async () => {
    const path = await linkFor('bea@example.test');
    const head = await app.inject({ method: 'HEAD', url: path });
    expect(head.headers['set-cookie']).toBeUndefined();
    expect((await verify(path)).headers.location).toBe('/courses?view=student');
  });

  test('is rate limited per client', async () => {
    const limited = await makeApp({ AUTH_VERIFY_RATE_LIMIT: '2' });
    const use = () => limited.inject({ method: 'GET', url: '/api/auth/verify?token=forged' });
    expect((await use()).statusCode).toBe(302);
    expect((await use()).statusCode).toBe(302);
    expect((await use()).statusCode).toBe(429);
  });

  test('a link works once', async () => {
    const path = await linkFor('bea@example.test', { next: '/classes/x/topics' });
    expect((await verify(path)).statusCode).toBe(302);
    const again = await verify(path);
    expect(again.statusCode).toBe(302);
    expect(again.headers.location).toBe(
      `/signin?link=expired&next=${encodeURIComponent('/classes/x/topics')}`,
    );
    expect(again.headers['set-cookie']).toBeUndefined();
  });

  test('two simultaneous uses of one link start exactly one session', async () => {
    const path = await linkFor('bea@example.test');
    const results = await Promise.all([verify(path), verify(path)]);
    const withCookie = results.filter((r) => r.headers['set-cookie'] !== undefined);
    expect(withCookie).toHaveLength(1);
  });

  test('a link expires after 15 minutes', async () => {
    const path = await linkFor('bea@example.test');
    clock = new Date(t0.getTime() + 15 * 60_000);
    const res = await verify(path);
    expect(res.headers.location).toMatch(/^\/signin\?link=expired/);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('a link still works just inside 15 minutes', async () => {
    const path = await linkFor('bea@example.test');
    clock = new Date(t0.getTime() + 15 * 60_000 - 1);
    expect((await verify(path)).headers.location).toBe('/courses?view=student');
  });

  test('unknown, missing or mangled tokens go to the expired-link page without a destination', async () => {
    for (const path of [
      '/api/auth/verify?token=forged',
      '/api/auth/verify',
      `/api/auth/verify?token=${'a'.repeat(300)}`,
      '/api/auth/verify?token=a&token=b',
      '/api/auth/verify?token[]=x',
    ]) {
      const res = await verify(path);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/signin?link=expired');
    }
  });

  test('redirects to the preserved destination', async () => {
    const next = `/classes/${ids.classA}/topics/t1/reading?resource=r2#b12`;
    const res = await verify(await linkFor('sam@example.test', { next }));
    expect(res.headers.location).toBe(next);
  });

  test.each([
    'https://evil.example/phish',
    '//evil.example/phish',
    '/\\evil.example',
    'javascript:alert(1)',
    '/api/auth/signout',
    '/..//evil.example',
    '/.//evil.example',
    '/a/..//evil.example/x',
    '/%2e%2e//evil.example',
  ])('rejects open redirect destination %j', async (next) => {
    const path = await linkFor('sam@example.test', { next, entrance: 'instructor' });
    // Refused when the link is requested: the stored destination is never off-origin.
    const token = new URL(path, APP_ORIGIN).searchParams.get('token') ?? '';
    const [stored] = await testDb.db
      .select({ destination: signinTokens.destination })
      .from(signinTokens)
      .where(eq(signinTokens.tokenHash, hashToken(token)));
    expect(stored?.destination).toBe('/courses?view=instructor');
    const res = await verify(path);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/courses?view=instructor');
  });

  test('a failure after the link is consumed rolls everything back: the link works on retry', async () => {
    const path = await linkFor('priya@example.test');
    // A session of its own: the shared fixture cookie belongs to the rotation test below.
    const held = await createSession(testDb.db, ids.priya, { now: clock });
    const before = cookieFor(held.token);
    await testDb.db.execute(
      sql`create function pc_refuse_session() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end $$`,
    );
    await testDb.db.execute(
      sql`create trigger pc_refuse_session before insert on auth_sessions for each row execute function pc_refuse_session()`,
    );
    try {
      const failed = await verify(path, before);
      expect(failed.statusCode).toBe(500);
      expect(failed.headers['set-cookie']).toBeUndefined();
    } finally {
      await testDb.db.execute(sql`drop trigger pc_refuse_session on auth_sessions`);
      await testDb.db.execute(sql`drop function pc_refuse_session()`);
    }
    // Neither the link nor the person's existing session was spent.
    expect((await me(before)).statusCode).toBe(200);
    const retry = await verify(path, before);
    expect(retry.statusCode).toBe(302);
    expect(retry.headers.location).toBe('/courses?view=student');
    expect((await me(sessionCookieFrom(retry))).json().user.id).toBe(ids.priya);
  });

  describe('a sign-in during a draft preview', () => {
    async function startPreview() {
      const held = await createSession(testDb.db, ids.marcus, { now: clock });
      const marcus = cookieFor(held.token);
      const started = await app.inject({
        method: 'POST',
        url: `/api/courses/${ids.statistics}/preview`,
        headers: { cookie: marcus },
        payload: { classId: ids.classB },
      });
      expect(started.statusCode).toBe(200);
      const jar = started.cookies
        .filter((c) => c.value)
        .map((c) => `${c.name}=${encodeURIComponent(c.value)}`)
        .join('; ');
      return { marcus, jar };
    }

    test('ends the kept instructor session along with the preview session', async () => {
      const { marcus, jar } = await startPreview();
      const res = await verify(await linkFor('priya@example.test'), jar);
      expect(res.statusCode).toBe(302);
      expect(res.cookies.find((c) => c.name === 'pc_preview_return')?.value).toBe('');
      expect((await me(marcus)).statusCode).toBe(401);
      expect((await me(sessionCookieFrom(res))).json().user.id).toBe(ids.priya);
    });

    test('a failure rolls the kept instructor session’s end back with the link', async () => {
      const { marcus, jar } = await startPreview();
      const path = await linkFor('priya@example.test');
      await testDb.db.execute(
        sql`create function pc_refuse_session() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end $$`,
      );
      await testDb.db.execute(
        sql`create trigger pc_refuse_session before insert on auth_sessions for each row execute function pc_refuse_session()`,
      );
      try {
        expect((await verify(path, jar)).statusCode).toBe(500);
      } finally {
        await testDb.db.execute(sql`drop trigger pc_refuse_session on auth_sessions`);
        await testDb.db.execute(sql`drop function pc_refuse_session()`);
      }
      expect((await me(marcus)).statusCode).toBe(200);
      expect((await verify(path, jar)).statusCode).toBe(302);
      expect((await me(marcus)).statusCode).toBe(401);
    });
  });

  test('rotates the session: a session held before sign-in is ended', async () => {
    const before = world.cookie.priya;
    expect((await me(before)).statusCode).toBe(200);
    const res = await verify(await linkFor('priya@example.test'), before);
    const after = sessionCookieFrom(res);
    expect(after).not.toBe(before);
    expect((await me(before)).statusCode).toBe(401);
    expect((await me(after)).json().user.id).toBe(ids.priya);
  });
});

describe('POST /api/auth/signout', () => {
  test('ends the session and clears the cookie', async () => {
    const cookie = sessionCookieFrom(await verify(await linkFor('bea@example.test')));
    const res = await app.inject({ method: 'POST', url: '/api/auth/signout', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ signedOut: true });
    const cleared = res.cookies.find((c) => c.name === 'pc_session');
    expect(cleared?.value).toBe('');
    expect(cleared?.expires?.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await me(cookie)).statusCode).toBe(401);
  });

  test('succeeds without a session, and clears no cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/signout' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('a request carrying only other sites’ cookies clears nothing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signout',
      headers: { cookie: 'theme=dark; other_session=abc' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('a kept preview-return cookie alone still ends the kept instructor session', async () => {
    const held = await createSession(testDb.db, ids.marcus, { now: clock });
    const marcus = cookieFor(held.token);
    const started = await app.inject({
      method: 'POST',
      url: `/api/courses/${ids.statistics}/preview`,
      headers: { cookie: marcus },
      payload: { classId: ids.classB },
    });
    expect(started.statusCode).toBe(200);
    const kept = started.cookies.find((c) => c.name === 'pc_preview_return');
    if (!kept) throw new Error('no preview-return cookie');
    // The browser lost its session cookie (it lives 14 days, this one 8 hours).
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signout',
      headers: { cookie: `pc_preview_return=${encodeURIComponent(kept.value)}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.find((c) => c.name === 'pc_preview_return')?.value).toBe('');
    expect((await me(marcus)).statusCode).toBe(401);
  });

  test('a cookie the server cannot unsign (rotated secret) is still cleared', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signout',
      headers: { cookie: 'pc_session=forged.value' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.find((c) => c.name === 'pc_session')?.value).toBe('');
  });
});

describe('rate limits behind a proxy', () => {
  const from = (instance: FastifyInstance, forwarded: string) =>
    instance.inject({
      method: 'POST',
      url: '/api/auth/link',
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': forwarded },
      payload: { email: `proxy-${forwarded}@example.test` },
    });

  test('with TRUST_PROXY each forwarded client has its own budget', async () => {
    const proxied = await makeApp({ AUTH_LINK_RATE_LIMIT: '1', TRUST_PROXY: '10.0.0.0/8' });
    expect((await from(proxied, '203.0.113.1')).statusCode).toBe(202);
    expect((await from(proxied, '203.0.113.1')).statusCode).toBe(429);
    expect((await from(proxied, '203.0.113.2')).statusCode).toBe(202);
    await background.settled();
  });

  test('without TRUST_PROXY a forwarded address is ignored: the proxy is the client', async () => {
    const direct = await makeApp({ AUTH_LINK_RATE_LIMIT: '1' });
    expect((await from(direct, '203.0.113.1')).statusCode).toBe(202);
    expect((await from(direct, '203.0.113.2')).statusCode).toBe(429);
    await background.settled();
  });
});

test('baseline security headers are set on API responses', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(res.headers['content-security-policy']).toContain("default-src 'self'");
});

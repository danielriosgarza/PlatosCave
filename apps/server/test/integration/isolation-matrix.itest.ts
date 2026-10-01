import { defineRoute, type RouteContract } from '@parallax/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../../src/app';
import { createSession } from '../../src/auth/sessions';
import { loadConfig } from '../../src/config';
import { authSessions } from '../../src/db/schema';
import { registerRoute } from '../../src/http/register';
import { buildWorld, cookieFor, ids, type PersonName, people, type World } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

const now = new Date('2026-10-01T09:00:00Z');
const classParams = z.object({ classId: z.uuid() });
const courseParams = z.object({ courseId: z.uuid() });
const exampleClass = { classId: ids.classA };
const exampleCourse = { courseId: ids.statistics };

/** Test-only routes covering every role and grant the resolver distinguishes. */
const probes = [
  defineRoute({
    method: 'GET',
    path: '/api/classes/:classId/probe/instructor',
    scope: { kind: 'class', role: 'instructor' },
    summary: 'probe',
    params: classParams,
    response: z.object({}),
    examples: { params: exampleClass },
  }),
  defineRoute({
    method: 'GET',
    path: '/api/classes/:classId/probe/student',
    scope: { kind: 'class', role: 'student' },
    summary: 'probe',
    params: classParams,
    response: z.object({}),
    examples: { params: exampleClass },
  }),
  defineRoute({
    method: 'POST',
    path: '/api/classes/:classId/probe/members',
    scope: { kind: 'class', role: 'instructor', grant: 'manage_members' },
    summary: 'probe',
    params: classParams,
    body: z.object({ email: z.email() }),
    response: z.object({}),
    examples: { params: exampleClass, body: { email: 'new@example.test' } },
  }),
  ...(['editor', 'publisher', 'owner'] as const).map((role) =>
    defineRoute({
      method: 'GET',
      path: `/api/courses/:courseId/probe/${role}`,
      scope: { kind: 'course', role },
      summary: 'probe',
      params: courseParams,
      response: z.object({}),
      examples: { params: exampleCourse },
    }),
  ),
];

const recentAuthProbe = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/probe/sensitive',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'probe',
  params: classParams,
  response: z.object({ ok: z.boolean() }),
  examples: { params: exampleClass },
});

type Role = 'student' | 'instructor';
const classRoles: Record<string, Partial<Record<PersonName, Role>>> = {
  [ids.classA]: { priya: 'instructor', noor: 'instructor', sam: 'student' },
  [ids.classB]: { marcus: 'instructor', bea: 'student', priya: 'student', previewB: 'student' },
};
/** Who satisfies `grant: 'manage_members'`: the course owner and Noor, who holds the grant. */
const classManagers: Record<string, PersonName[]> = {
  [ids.classA]: ['elena', 'noor'],
  [ids.classB]: ['elena'],
};
type Grant = 'owner' | 'editor' | 'publisher';
const courseGrants: Record<string, Partial<Record<PersonName, Grant[]>>> = {
  [ids.statistics]: {
    elena: ['owner'],
    marcus: ['editor'],
    priya: ['editor'],
    noor: ['editor'],
    ines: ['publisher'],
  },
  [ids.linearModels]: { olivia: ['owner'] },
};

/** What the resolver must answer: 'pass' means the request reached the handler stage. */
function expected(contract: RouteContract, scopeId: string, who: PersonName): 'pass' | 403 | 404 {
  const { scope } = contract;
  if (scope.kind === 'class') {
    if (scope.grant && classManagers[scopeId]?.includes(who)) return 'pass';
    const role = classRoles[scopeId]?.[who];
    if (!role) return 404;
    if (scope.role !== 'any' && scope.role !== role) return 403;
    return scope.grant ? 403 : 'pass';
  }
  if (scope.kind === 'course') {
    const grants = courseGrants[scopeId]?.[who];
    if (!grants) return 404;
    return grants.includes('owner') || grants.includes(scope.role) ? 'pass' : 403;
  }
  throw new Error(`unexpected scope ${scope.kind}`);
}

function requestFor(contract: RouteContract, override: Record<string, string>) {
  const params = { ...(contract.examples.params as Record<string, string>), ...override };
  const url = contract.path.replace(/:(\w+)/g, (_, k: string) => {
    const v = params[k];
    if (v === undefined) throw new Error(`${contract.path}: examples.params lacks ${k}`);
    return encodeURIComponent(String(v));
  });
  const query = contract.examples.query as Record<string, string> | undefined;
  return {
    method: contract.method,
    url: query ? `${url}?${new URLSearchParams(query)}` : url,
    ...(contract.examples.body !== undefined && { payload: contract.examples.body as object }),
  };
}

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, now);
  app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), {
    db: testDb.db,
    now: () => now,
  });
  // Runs after the scope resolver and validation: marks requests the resolver let through.
  app.addHook('preHandler', async (_req, reply) => {
    reply.header('x-test-reached', '1');
  });
  for (const probe of probes) registerRoute(app, probe, () => ({}));
  registerRoute(app, recentAuthProbe, ({ scope }) => {
    scope.requireRecentAuth();
    return { ok: true };
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

async function send(contract: RouteContract, override: Record<string, string>, who?: PersonName) {
  const res = await app.inject({
    ...requestFor(contract, override),
    headers: who ? { cookie: world.cookie[who] } : {},
  });
  return {
    status: res.statusCode,
    body: res.json(),
    reached: res.headers['x-test-reached'] === '1',
  };
}

describe('isolation matrix over every registered scoped contract', () => {
  test('every scoped contract has valid examples', () => {
    const scoped = app.contracts.filter((c) => c.scope.kind !== 'public');
    expect(scoped.map((c) => c.path)).toContain('/api/classes/:classId');
    for (const c of scoped) {
      for (const part of ['params', 'query', 'body'] as const) {
        const schema = c[part];
        if (schema)
          expect(schema.safeParse(c.examples[part]).success, `${c.path} ${part}`).toBe(true);
      }
    }
  });

  test('A01 A21 foreign principals get 404, wrong role or grant 403, members pass', async () => {
    const failures: string[] = [];
    for (const contract of app.contracts) {
      const { kind } = contract.scope;
      if (kind !== 'class' && kind !== 'course') continue;
      const scopeIds =
        kind === 'class' ? [ids.classA, ids.classB] : [ids.statistics, ids.linearModels];
      for (const scopeId of scopeIds) {
        for (const who of people) {
          const want = expected(contract, scopeId, who);
          const res = await send(contract, { [`${kind}Id`]: scopeId }, who);
          const got = res.reached ? 'pass' : res.status;
          if (got !== want) {
            failures.push(
              `${contract.method} ${contract.path} ${scopeId} ${who}: ${got} ≠ ${want}`,
            );
          }
          if (!res.reached && res.body.error === undefined) failures.push(`${who}: no error body`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test('A01 every non-public contract answers 401 without a session', async () => {
    for (const contract of app.contracts.filter((c) => c.scope.kind !== 'public')) {
      const res = await send(contract, {});
      expect(res.status, contract.path).toBe(401);
      expect(res.reached).toBe(false);
    }
  });

  test('preview principal never reaches instructor or course routes', async () => {
    for (const contract of app.contracts) {
      const { scope } = contract;
      if (scope.kind === 'course' || (scope.kind === 'class' && scope.role === 'instructor')) {
        for (const scopeId of [ids.classB, ids.statistics]) {
          expect((await send(contract, { [`${scope.kind}Id`]: scopeId }, 'previewB')).reached).toBe(
            false,
          );
        }
      }
    }
  });
});

const getClassUrl = (classId: string) => `/api/classes/${classId}`;
const get = (url: string, who: PersonName) =>
  app.inject({ method: 'GET', url, headers: { cookie: world.cookie[who] } });

describe('scenario checks at the API level', () => {
  test('A01 student altering the class id gets 404 for another cohort, 403 for instructor data', async () => {
    const own = await get(getClassUrl(ids.classA), 'sam');
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ id: ids.classA, role: 'student', name: 'Autumn 2026 A' });
    const other = await get(getClassUrl(ids.classB), 'sam');
    expect(other.statusCode).toBe(404);
    expect(other.json()).toEqual({ error: 'not found' });
    const unknown = await get(getClassUrl('00000000-0000-4000-8000-999999999999'), 'sam');
    expect(unknown.json()).toEqual(other.json());
    const notUuid = await get(getClassUrl('not-a-uuid'), 'sam');
    expect(notUuid.statusCode).toBe(404);
    const instructor = await get(`${getClassUrl(ids.classA)}/probe/instructor`, 'sam');
    expect(instructor.statusCode).toBe(403);
    expect(instructor.json()).toEqual({ error: 'forbidden' });
  });

  test('A01 a non-member learns nothing from validation: bad body still yields 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${getClassUrl(ids.classA)}/probe/members`,
      headers: { cookie: world.cookie.bea, 'content-type': 'application/json' },
      payload: '{"email": 42',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
  });

  test('A02 one person teaching A and studying in B holds only each context’s permissions', async () => {
    const a = await get(getClassUrl(ids.classA), 'priya');
    expect(a.json()).toMatchObject({ role: 'instructor', grants: { manageMembers: false } });
    const b = await get(getClassUrl(ids.classB), 'priya');
    expect(b.json()).toMatchObject({ role: 'student' });
    expect((await get(`${getClassUrl(ids.classA)}/probe/instructor`, 'priya')).statusCode).toBe(
      200,
    );
    expect((await get(`${getClassUrl(ids.classB)}/probe/instructor`, 'priya')).statusCode).toBe(
      403,
    );
    expect((await get(`${getClassUrl(ids.classA)}/probe/student`, 'priya')).statusCode).toBe(403);

    const me = await get('/api/me', 'priya');
    expect(me.statusCode).toBe(200);
    const body = me.json();
    expect(body.user).toEqual({
      id: ids.priya,
      name: 'Priya Nair',
      email: 'priya@example.test',
      kind: 'user',
    });
    const contexts = body.classes.map((c: { classId: string; role: string }) => [
      c.classId,
      c.role,
    ]);
    expect(contexts).toEqual([
      [ids.classA, 'instructor'],
      [ids.classB, 'student'],
    ]);
    expect(body.courses).toEqual([
      {
        courseId: ids.statistics,
        title: 'Statistical thinking',
        owner: false,
        editor: true,
        publisher: false,
      },
    ]);
  });

  test('A21 the two cohorts of one course cannot see each other’s class', async () => {
    for (const who of ['bea', 'marcus', 'previewB'] as const) {
      expect((await get(getClassUrl(ids.classA), who)).statusCode).toBe(404);
    }
    expect((await get(getClassUrl(ids.classB), 'sam')).statusCode).toBe(404);
    const head = await app.inject({
      method: 'HEAD',
      url: getClassUrl(ids.classA),
      headers: { cookie: world.cookie.bea },
    });
    expect(head.statusCode).toBe(404);
    // Owning the course is not class access (§3: "Only with class access").
    expect((await get(getClassUrl(ids.classA), 'elena')).statusCode).toBe(404);
  });

  test('expired, forged and revoked sessions are refused', async () => {
    const stale = await createSession(testDb.db, ids.sam, {
      now: new Date('2026-01-01T00:00:00Z'),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: cookieFor(stale.token) },
    });
    expect(res.statusCode).toBe(401);
    const forged = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: 'pc_session=forged' },
    });
    expect(forged.statusCode).toBe(401);
    const live = await createSession(testDb.db, ids.sam, { now });
    await testDb.db
      .update(authSessions)
      .set({ revokedAt: now })
      .where(eq(authSessions.id, live.sessionId));
    const revoked = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: cookieFor(live.token) },
    });
    expect(revoked.statusCode).toBe(401);
  });

  test('requireRecentAuth refuses a session authenticated more than 15 minutes ago', async () => {
    const url = `${getClassUrl(ids.classB)}/probe/sensitive`;
    const fresh = await app.inject({
      method: 'POST',
      url,
      headers: { cookie: world.cookie.marcus },
    });
    expect(fresh.json()).toEqual({ ok: true });
    const old = await createSession(testDb.db, ids.marcus, {
      now,
      authTime: new Date(now.getTime() - 16 * 60_000),
    });
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { cookie: cookieFor(old.token) },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'recent_auth_required' });
  });
});

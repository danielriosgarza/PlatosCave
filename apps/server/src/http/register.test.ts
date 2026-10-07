import { conflictBody, defineRoute, errorBody } from '@parallax/contracts';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../app';
import type { ClassScope, UserScope } from '../auth/scope';
import { loadConfig } from '../config';
import { notFound, type RouteArgs, registerRoute, registerWebSocketRoute } from './register';

const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });

const echo = defineRoute({
  method: 'GET',
  path: '/api/echo/:n',
  scope: { kind: 'public' },
  summary: 'echo',
  params: z.object({ n: z.coerce.number() }),
  response: z.object({ n: z.number() }),
  examples: { params: { n: 1 } },
});

const secret = defineRoute({
  method: 'GET',
  path: '/api/secret',
  scope: { kind: 'user' },
  summary: 'secret',
  response: z.object({}),
  examples: {},
});

const classEcho = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/echo/:n',
  scope: { kind: 'class', role: 'student' },
  summary: 'class echo',
  params: z.object({ classId: z.uuid(), n: z.coerce.number() }),
  response: z.object({ n: z.number() }),
  examples: { params: { classId: '00000000-0000-4000-8000-000000000000', n: 1 } },
});

const versioned = defineRoute({
  method: 'PUT',
  path: '/api/versioned/:n',
  scope: { kind: 'public' },
  summary: 'versioned',
  params: z.object({ n: z.coerce.number() }),
  response: z.object({ n: z.number() }),
  errors: { 409: conflictBody(z.object({ n: z.number() })) },
  examples: { params: { n: 1 } },
});

describe('registerRoute and the scope guard', () => {
  it('refuses an /api route registered without a scope', async () => {
    const app = await buildApp(config);
    expect(() => app.get('/api/x', async () => ({}))).toThrow(/has no scope/);
    expect(() => app.get('/api', async () => ({}))).toThrow(/has no scope/);
    await app.close();
  });

  it('boots with registerRoute and validates params', async () => {
    const app = await buildApp(config);
    registerRoute(app, echo, ({ params }) => ({ n: params.n }));
    const ok = await app.inject({ method: 'GET', url: '/api/echo/7' });
    expect(ok.json()).toEqual({ n: 7 });
    const bad = await app.inject({ method: 'GET', url: '/api/echo/abc' });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('answers 401 before validation for a non-public scope without a session', async () => {
    const app = await buildApp(config);
    registerRoute(app, secret, () => ({}));
    registerRoute(app, classEcho, ({ params }) => ({ n: params.n }));
    const res = await app.inject({ method: 'GET', url: '/api/secret' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthenticated' });
    const invalid = await app.inject({ method: 'GET', url: '/api/classes/nope/echo/abc' });
    expect(invalid.statusCode).toBe(401);
    await app.close();
  });

  it('refuses a route whose scope does not resolve the ids in its path', async () => {
    const app = await buildApp(config);
    const raw = { ...classEcho, scope: { kind: 'user' as const } };
    expect(() => registerRoute(app, raw, () => ({ n: 1 }))).toThrow(/names :classId/);
    const noId = { ...secret, scope: { kind: 'class' as const, role: 'any' as const } };
    expect(() => registerRoute(app, noId, () => ({}))).toThrow(/no :classId/);
    await app.close();
  });

  it('answers unknown /api paths with the JSON 404 body without STATIC_DIR', async () => {
    const app = await buildApp(config);
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
    await app.close();
  });

  it('types omitted parts as undefined and the scope by its kind', () => {
    type Health = RouteArgs<typeof secret>;
    expectTypeOf<Health['params']>().toEqualTypeOf<undefined>();
    expectTypeOf<Health['body']>().toEqualTypeOf<undefined>();
    expectTypeOf<Health['scope']>().toEqualTypeOf<UserScope>();
    type Cls = RouteArgs<typeof classEcho>;
    expectTypeOf<Cls['params']>().toEqualTypeOf<{ classId: string; n: number }>();
    expectTypeOf<Cls['scope']>().toEqualTypeOf<ClassScope>();
  });

  it('answers a handler conflict with the declared 409 body and a missing row with 404', async () => {
    const app = await buildApp(config);
    registerRoute(app, versioned, ({ params, conflict }) => {
      if (params.n === 0) return notFound();
      if (params.n > 1) return conflict({ error: 'revision_conflict', current: { n: 1 } });
      return { n: params.n };
    });
    expect((await app.inject({ method: 'PUT', url: '/api/versioned/1' })).json()).toEqual({ n: 1 });
    const stale = await app.inject({ method: 'PUT', url: '/api/versioned/2' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'revision_conflict', current: { n: 1 } });
    const missing = await app.inject({ method: 'PUT', url: '/api/versioned/0' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'not found' });
    await app.close();
  });

  it('documents draft routes and their 409 bodies in openapi', async () => {
    const app = await buildApp(config);
    const spec = (await app.inject({ method: 'GET', url: '/api/openapi.json' })).json();
    const patch = spec.paths['/api/courses/{courseId}/resources/{resourceId}'].patch;
    expect(Object.keys(patch.responses)).toEqual(expect.arrayContaining(['200', '409']));
    expect(Object.keys(spec.paths)).toContain('/api/courses/{courseId}/drafts');
    await app.close();
  });

  it('serves health with db skipped and lists it in openapi', async () => {
    const app = await buildApp(config);
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.json()).toMatchObject({ status: 'ok', db: 'skipped' });
    const spec = await app.inject({ method: 'GET', url: '/api/openapi.json' });
    expect(Object.keys(spec.json().paths)).toContain('/api/health');
    await app.close();
  });
});

describe('openapi.json outside production only', () => {
  const production = loadConfig({
    NODE_ENV: 'production',
    LOG_LEVEL: 'silent',
    SESSION_SECRET: 's'.repeat(32),
    APP_ORIGIN: 'https://parallax.example.org',
    CONTENT_ORIGIN: 'https://content.example.org',
    CONTENT_HOST: 'content.example.org',
    CONTENT_TOKEN_SECRET: 'c'.repeat(32),
    TRUST_PROXY: 'false',
  });

  it('AUD21 answers 404 with the normal not-found body in production', async () => {
    const app = await buildApp(production);
    const res = await app.inject({ method: 'GET', url: '/api/openapi.json' });
    const unknown = await app.inject({ method: 'GET', url: '/api/no-such-route' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(unknown.json());
    await app.close();
  });

  it.each(['development', 'test'] as const)('AUD21 serves the spec in %s', async (env) => {
    const app = await buildApp(loadConfig({ NODE_ENV: env, LOG_LEVEL: 'silent' }));
    const res = await app.inject({ method: 'GET', url: '/api/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().paths)).toContain('/api/openapi.json');
    await app.close();
  });
});

describe('registerRoute rate limits', () => {
  const route = (path: `/api/${string}`, kind: 'public' | 'user') =>
    defineRoute({
      method: 'GET',
      path,
      scope: { kind } as { kind: 'public' } | { kind: 'user' },
      summary: 'limited',
      response: z.object({}),
      errors: { 429: errorBody },
      examples: {},
    });

  it('limits before resolving the scope, and keeps a separate count per route', async () => {
    const app = await buildApp(config);
    const rateLimit = { max: 1, timeWindow: '1 minute' };
    registerRoute(app, route('/api/limited/a', 'public'), () => ({}), { rateLimit });
    registerRoute(app, route('/api/limited/b', 'public'), () => ({}), { rateLimit });
    registerRoute(app, route('/api/limited/user', 'user'), () => ({}), { rateLimit });
    await app.ready();
    const status = async (url: string) => (await app.inject({ url })).statusCode;

    expect(await status('/api/limited/a')).toBe(200);
    expect(await status('/api/limited/b')).toBe(200);
    expect(await status('/api/limited/a')).toBe(429);
    expect(await status('/api/limited/b')).toBe(429);
    // Without a session the resolver answers 401; once over the limit the limiter answers first.
    expect(await status('/api/limited/user')).toBe(401);
    expect(await status('/api/limited/user')).toBe(429);
    await app.close();
  });

  it('routes given one shared limiter draw on one budget', async () => {
    const app = await buildApp(config);
    const sharedRateLimit = app.rateLimit({ max: 2, timeWindow: '1 minute' });
    registerRoute(app, route('/api/shared/a', 'public'), () => ({}), { sharedRateLimit });
    registerRoute(app, route('/api/shared/b', 'public'), () => ({}), { sharedRateLimit });
    await app.ready();
    const status = async (url: string) => (await app.inject({ url })).statusCode;

    expect(await status('/api/shared/a')).toBe(200);
    expect(await status('/api/shared/b')).toBe(200);
    expect(await status('/api/shared/a')).toBe(429);
    expect(await status('/api/shared/b')).toBe(429);
    await app.close();
  });
});

it('API routes get no implicit HEAD route, so a HEAD never runs a handler', async () => {
  const app = await buildApp(config);
  let calls = 0;
  registerRoute(app, echo, ({ params }) => {
    calls += 1;
    return { n: params.n };
  });
  await app.ready();
  expect((await app.inject({ method: 'HEAD', url: '/api/echo/1' })).statusCode).toBe(404);
  expect(calls).toBe(0);
  expect((await app.inject({ method: 'GET', url: '/api/echo/1' })).json()).toEqual({ n: 1 });
  await app.close();
});

describe('registerWebSocketRoute (relay mode)', () => {
  const socketRoute = <S extends { kind: 'public' } | { kind: 'user' }>(
    path: `/api/${string}`,
    scope: S,
  ) =>
    defineRoute({
      method: 'GET',
      path,
      scope,
      summary: 'socket',
      websocket: true,
      response: z.never(),
      examples: {},
    });

  it('refuses at boot a WebSocket contract without a scope', async () => {
    const app = await buildApp(config, { mode: 'relay' });
    const unscoped = { ...socketRoute('/api/socket', { kind: 'public' }), scope: undefined };
    expect(() => registerWebSocketRoute(app, unscoped as never, () => {})).toThrow(
      /declares no scope/,
    );
    await app.close();
  });

  it('keeps WebSocket and HTTP contracts apart, and needs relay mode', async () => {
    const relay = await buildApp(config, { mode: 'relay' });
    expect(() =>
      registerRoute(
        relay,
        socketRoute('/api/socket', { kind: 'public' }),
        () => undefined as never,
      ),
    ).toThrow(/registerWebSocketRoute/);
    expect(() => registerWebSocketRoute(relay, echo as never, () => {})).toThrow(/registerRoute/);
    await relay.close();
    const api = await buildApp(config);
    expect(() =>
      registerWebSocketRoute(api, socketRoute('/api/socket', { kind: 'public' }), () => {}),
    ).toThrow(/relay mode/);
    await api.close();
  });

  it('resolves the scope before the upgrade: a refusal is HTTP and opens no socket', async () => {
    const app = await buildApp(config, { mode: 'relay' });
    let opened = 0;
    registerWebSocketRoute(app, socketRoute('/api/socket/user', { kind: 'user' }), () => {
      opened += 1;
    });
    await app.ready();
    await expect(app.injectWS('/api/socket/user')).rejects.toThrow(/401/);
    expect((await app.inject({ url: '/api/socket/user' })).statusCode).toBe(401);
    expect(opened).toBe(0);
    await app.close();
  });

  it('hands an upgraded socket to the handler; a plain GET is the shared 404', async () => {
    const app = await buildApp(config, { mode: 'relay' });
    registerWebSocketRoute(app, socketRoute('/api/socket/echo', { kind: 'public' }), (socket) => {
      socket.on('message', (data) => socket.send(`echo ${data.toString()}`));
    });
    await app.ready();
    const ws = await app.injectWS('/api/socket/echo');
    const reply = new Promise<string>((resolve) =>
      ws.once('message', (d) => resolve(d.toString())),
    );
    ws.send('hi');
    expect(await reply).toBe('echo hi');
    ws.terminate();
    const plain = await app.inject({ url: '/api/socket/echo' });
    expect(plain.statusCode).toBe(404);
    expect(plain.json()).toEqual({ error: 'not found' });
    await app.close();
  });

  it('serves the connector link in relay mode only', async () => {
    const api = await buildApp(config);
    expect(api.contracts.map((c) => c.path)).not.toContain('/api/connector/v1/link');
    await api.close();
    const relay = await buildApp(config, { mode: 'relay' });
    await relay.ready();
    expect(relay.contracts.map((c) => c.path)).toContain('/api/connector/v1/link');
    // Without a database no connector can authenticate: the socket is closed with 4500.
    const ws = await relay.injectWS('/api/connector/v1/link', {
      headers: { 'sec-websocket-protocol': 'parallax.connector.v1' },
    });
    const code = await new Promise<number>((resolve) => ws.once('close', (c) => resolve(c)));
    expect(code).toBe(4500);
    await relay.close();
  });
});

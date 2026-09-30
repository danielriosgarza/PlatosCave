import { defineRoute } from '@parallax/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { registerRoute } from './register';

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

  it('answers 401 for non-public scopes in Phase 0', async () => {
    const app = await buildApp(config);
    registerRoute(app, secret, () => ({}));
    const res = await app.inject({ method: 'GET', url: '/api/secret' });
    expect(res.statusCode).toBe(401);
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

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineRoute, errorBody, errorResponses, invalidBody } from '@parallax/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { invalid } from '../outcome';
import { type RouteArgs, registerRoute, settle } from './register';

const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', TEST_ROUTES: '1' });

/** OpenAPI path of a contract path: `/api/classes/:classId` → `/api/classes/{classId}`. */
const openapiPath = (path: string) => path.replace(/:(\w+)/g, '{$1}');

describe('AUD15 error replies', () => {
  it('AUD15 the OpenAPI document lists exactly the success and error statuses of every contract', async () => {
    const app = await buildApp(config);
    const doc = (await app.inject({ method: 'GET', url: '/api/openapi.json' })).json();
    expect(app.contracts.length).toBeGreaterThan(40);
    for (const contract of app.contracts) {
      const op = doc.paths[openapiPath(contract.path)]?.[contract.method.toLowerCase()];
      const name = `${contract.method} ${contract.path}`;
      expect(op, name).toBeDefined();
      const expected = [
        contract.status ?? 200,
        ...(contract.alternativeStatus ? [contract.alternativeStatus] : []),
        ...Object.keys(errorResponses(contract)),
      ].map(String);
      expect(Object.keys(op.responses).sort(), name).toEqual(expected.sort());
    }
    // Spot checks of statuses the handlers raise themselves (they were missing before).
    const op = (method: string, path: string) => doc.paths[path][method].responses;
    expect(Object.keys(op('post', '/api/courses/{courseId}/releases'))).toContain('422');
    expect(Object.keys(op('post', '/api/invitations/accept'))).toEqual(
      expect.arrayContaining(['403', '404', '409', '410', '429']),
    );
    expect(Object.keys(op('post', '/api/preview/exit'))).toContain('409');
    expect(Object.keys(op('post', '/api/courses'))).toContain('403');
    // An archived class refuses a position save and a Colab launch with 409 `class_archived`.
    expect(Object.keys(op('put', '/api/classes/{classId}/positions'))).toContain('409');
    expect(
      Object.keys(op('post', '/api/classes/{classId}/resources/{resourceId}/colab-launch')),
    ).toContain('409');
    await app.close();
  });

  it('AUD15 no route module answers on its own: failures go through registerRoute', async () => {
    const dir = resolve(import.meta.dirname, 'routes');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.routes.ts'));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const source = await readFile(resolve(dir, file), 'utf8');
      // reply.code(…) / reply.status(…) would send a status registerRoute never checks.
      expect(source, file).not.toMatch(/\.(code|status)\(\s*\d/);
      expect(source, file).not.toMatch(/\brefuse\(/);
    }
  });

  const route = defineRoute({
    method: 'POST',
    path: '/api/aud15/:n',
    scope: { kind: 'public' },
    summary: 'aud15',
    params: z.object({ n: z.coerce.number() }),
    response: z.object({ n: z.number() }),
    errors: { 409: z.object({ error: z.literal('busy') }), 422: errorBody },
    examples: { params: { n: 1 } },
  });

  const bare = defineRoute({
    method: 'POST',
    path: '/api/aud15-bare',
    scope: { kind: 'public' },
    summary: 'aud15 bare',
    response: z.object({}),
    examples: {},
  });

  it('AUD15 fail answers a declared status with its body; settle answers 400 { error, message }', async () => {
    const app = await buildApp(config);
    registerRoute(app, route, ({ params, fail }) => {
      if (params.n === 1) return fail(409, { error: 'busy' });
      if (params.n === 2) return settle(invalid('Write the question first'));
      return { n: params.n };
    });
    const busy = await app.inject({ method: 'POST', url: '/api/aud15/1' });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({ error: 'busy' });
    const refused = await app.inject({ method: 'POST', url: '/api/aud15/2' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual(
      invalidBody.parse({ error: 'invalid', message: 'Write the question first' }),
    );
    // Schema validation keeps Fastify's body, which has the same `error` and `message`.
    const malformed = await app.inject({ method: 'POST', url: '/api/aud15/x' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ error: 'Bad Request', message: expect.any(String) });
    await app.close();
  });

  it('AUD15 a status the contract does not declare is answered as a 500, not sent', async () => {
    const app = await buildApp(config);
    registerRoute(app, bare, ({ req }) => {
      if (req.headers['x-case'] === 'settle') return settle(invalid('not declared'));
      if (req.headers['x-case'] === 'thrown') {
        throw Object.assign(new Error('gone'), { statusCode: 410 });
      }
      return {};
    });
    // A body that does not match the declared one is refused too.
    registerRoute(app, { ...route, path: '/api/aud15-shape/:n' }, ({ fail }) =>
      fail(409, { error: 'other' } as never),
    );
    for (const header of ['settle', 'thrown']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/aud15-bare',
        headers: { 'x-case': header },
      });
      expect(res.statusCode, header).toBe(500);
      expect(res.json()).toEqual({ error: 'internal error' });
    }
    const shape = await app.inject({ method: 'POST', url: '/api/aud15-shape/1' });
    expect(shape.statusCode).toBe(500);
    await app.close();
  });

  it('AUD15 a rate-limited route must declare 429', async () => {
    const app = await buildApp(config);
    const rateLimit = { max: 1, timeWindow: '1 minute' };
    expect(() => registerRoute(app, bare, () => ({}), { rateLimit })).toThrow(/declares no 429/);
    await app.close();
  });

  it('AUD15 fail only accepts the statuses and bodies the contract declares', () => {
    const typed = (fail: RouteArgs<typeof route>['fail']) => {
      fail(409, { error: 'busy' });
      fail(422, { error: 'anything' });
      // @ts-expect-error 410 is not declared
      fail(410, { error: 'gone' });
      // @ts-expect-error the 409 body is { error: 'busy' }
      fail(409, { error: 'other' });
    };
    const none = (fail: RouteArgs<typeof bare>['fail']) => {
      // @ts-expect-error a contract without errors declares nothing to fail with
      fail(409, { error: 'busy' });
    };
    expect([typed, none]).toHaveLength(2);
  });
});

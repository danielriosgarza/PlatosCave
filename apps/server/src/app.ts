import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import type { RouteContract } from '@parallax/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Config } from './config';
import type { Db } from './db/client';
import { redactContentUrl, registerContentOrigin } from './http/content';
import { isApiPath, registerStatic } from './http/static';
import { createStorage } from './storage/create';
import type { Storage } from './storage/storage';

declare module 'fastify' {
  interface FastifyInstance {
    /** Configuration and object store for content tokens and the content origin (P1-06). */
    contentDeps: { config: Config; storage: Storage };
  }
}

export interface Deps {
  db?: Db;
  /** Injected clock (ADR-0006); defaults to the system time. */
  now?: () => Date;
  /** Deadline for the health probe's database query; defaults to PROBE_TIMEOUT_MS. */
  probeTimeoutMs?: number;
  /** Object store; defaults to the one STORAGE_DRIVER selects. */
  storage?: Storage;
}

const NOT_FOUND = { error: 'not found' };

export async function buildApp(config: Config, deps: Deps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // Storage keys and content tokens are path parameters longer than the default 100.
    routerOptions: { maxParamLength: 1024 },
    logger: {
      level: config.LOG_LEVEL,
      serializers: {
        // Content tokens are credentials: keep them out of the logs.
        req: (req) => ({
          method: req.method,
          url: redactContentUrl(req.url),
          host: req.host,
          remoteAddress: req.ip,
        }),
      },
      ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
    },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const now = deps.now ?? (() => new Date());
  const storage = deps.storage ?? createStorage(config);
  app.decorate('resolverDeps', { db: deps.db, now });
  app.decorate('contentDeps', { config, storage });
  app.decorate('contracts', [] as RouteContract[]);
  app.decorateRequest('parallaxScope', undefined);

  // Structural guard (ADR-0002): every /api route must declare a scope via registerRoute().
  app.addHook('onRoute', (route) => {
    const routeConfig = route.config as { scope?: unknown; contract?: RouteContract } | undefined;
    if (isApiPath(route.url) && !routeConfig?.scope) {
      throw new Error(`${route.method} ${route.url} has no scope; use registerRoute()`);
    }
    if (routeConfig?.contract && route.method !== 'HEAD') app.contracts.push(routeConfig.contract);
  });

  // Before any route: splits requests between the app host and the content host.
  registerContentOrigin(app, { config, storage, now });

  await app.register(sensible);
  await app.register(swagger, {
    openapi: { info: { title: 'Parallax API', version: '0.0.0' } },
    transform: jsonSchemaTransform,
  });

  const routesDir = resolve(import.meta.dirname, 'http/routes');
  const files = readdirSync(routesDir)
    .filter((f) => /\.routes\.ts$/.test(f))
    .sort();
  for (const file of files) {
    const mod = await import(pathToFileURL(resolve(routesDir, file)).href);
    await app.register(async (instance) => {
      mod.default(instance, deps);
    });
  }

  const spa = config.STATIC_DIR ? await registerStatic(app, config.STATIC_DIR) : undefined;
  // One JSON 404 shape for unknown /api paths and non-members, in dev, tests and production.
  app.setNotFoundHandler((req, reply) => spa?.(req, reply) ?? reply.code(404).send(NOT_FOUND));
  return app;
}

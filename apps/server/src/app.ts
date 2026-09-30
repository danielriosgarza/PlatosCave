import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Config } from './config';
import type { Db } from './db/client';
import { isApiPath, registerStatic } from './http/static';

export interface Deps {
  db?: Db;
}

export async function buildApp(config: Config, deps: Deps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
    },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Structural guard (ADR-0002): every /api route must declare a scope via registerRoute().
  app.addHook('onRoute', (route) => {
    const routeConfig = route.config as { scope?: unknown } | undefined;
    if (isApiPath(route.url) && !routeConfig?.scope) {
      throw new Error(`${route.method} ${route.url} has no scope; use registerRoute()`);
    }
  });

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

  if (config.STATIC_DIR) await registerStatic(app, config.STATIC_DIR);
  return app;
}

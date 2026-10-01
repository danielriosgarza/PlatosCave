import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import type { RouteContract } from '@parallax/contracts';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Config } from './config';
import type { Db } from './db/client';
import { isApiPath, registerStatic } from './http/static';
import { createMailer, type Mailer } from './mail/mailer';

declare module 'fastify' {
  interface FastifyInstance {
    /** Configuration and mail transport for the sign-in routes. */
    authDeps: { config: Config; mailer: Mailer };
  }
}

export interface Deps {
  db?: Db;
  /** Injected clock (ADR-0006); defaults to the system time. */
  now?: () => Date;
  /** Deadline for the health probe's database query; defaults to PROBE_TIMEOUT_MS. */
  probeTimeoutMs?: number;
  /** Mail transport; defaults to the one MAIL_TRANSPORT selects. */
  mailer?: Mailer;
}

const NOT_FOUND = { error: 'not found' };

/** Sign-in link tokens must never reach the logs, even single-use ones. */
export const redactUrl = (url: string): string =>
  url.replace(/([?&]token=)[^&#]*/g, '$1[redacted]');

export async function buildApp(config: Config, deps: Deps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      serializers: {
        req: (req: FastifyRequest) => ({
          method: req.method,
          url: redactUrl(req.url),
          host: req.host,
          remoteAddress: req.ip,
        }),
      },
      ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
    },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('resolverDeps', { db: deps.db, now: deps.now ?? (() => new Date()) });
  app.decorate('contracts', [] as RouteContract[]);
  app.decorate('authDeps', { config, mailer: deps.mailer ?? createMailer(config) });
  app.decorateRequest('parallaxScope', undefined);

  // Structural guard (ADR-0002): every /api route must declare a scope via registerRoute().
  app.addHook('onRoute', (route) => {
    const routeConfig = route.config as { scope?: unknown; contract?: RouteContract } | undefined;
    if (isApiPath(route.url) && !routeConfig?.scope) {
      throw new Error(`${route.method} ${route.url} has no scope; use registerRoute()`);
    }
    if (routeConfig?.contract && route.method !== 'HEAD') app.contracts.push(routeConfig.contract);
  });

  await app.register(sensible);
  await app.register(cookie, { secret: config.SESSION_SECRET });
  // Baseline headers for the app origin; the content origin gets its own policy (P1-06).
  // Helmet's default Cross-Origin-Resource-Policy is same-origin on every response: P1-06 must
  // relax it on /content responses, or app-origin <img>/<video>/font loads from it are blocked.
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
      },
    },
  });
  // Only routes that opt in (registerRoute's `rateLimit` option) are limited.
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: ctx.statusCode,
      error: 'too many requests',
      message: `Try again in ${ctx.after}`,
    }),
  });
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

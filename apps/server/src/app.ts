import { resolve } from 'node:path';
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
import { MAX_TOKEN_LENGTH } from './content/tokens';
import type { Db } from './db/client';
import { CONTENT_ROUTE, isContentHost, registerContentOrigin } from './http/content';
import { redactUrl } from './http/redact';
import { NOT_FOUND } from './http/register';
import { isApiPath, registerStatic } from './http/static';
import { createMailer, type Mailer } from './mail/mailer';
import { loadModules } from './modules';
import { createStorage } from './storage/create';
import type { Storage } from './storage/storage';

declare module 'fastify' {
  interface FastifyInstance {
    /** Configuration and mail transport for the sign-in routes. */
    authDeps: { config: Config; mailer: Mailer };
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
  /** Mail transport; defaults to the one MAIL_TRANSPORT selects. */
  mailer?: Mailer;
  /** Object store; defaults to the one STORAGE_DRIVER selects. */
  storage?: Storage;
}

/**
 * The URL as logged. Sign-in tokens (query) and content tokens (path) are credentials: the content
 * route logs no token at all, and a request no route matched, on either host, logs only its first
 * path segment, since its raw path may be a token in a spelling the router rejected.
 */
export function logUrl(req: Pick<FastifyRequest, 'url'> & { routeOptions?: { url?: string } }) {
  const route = req.routeOptions?.url;
  if (route === CONTENT_ROUTE) return '/content/[redacted]';
  if (route === undefined) {
    // Plain characters only, and few: an encoded or long segment may itself be a token.
    const first = /^\/[A-Za-z0-9._~-]{0,32}/.exec(req.url)?.[0] ?? '/';
    return `${first}/…[unrouted]`;
  }
  return redactUrl(req.url);
}

export async function buildApp(config: Config, deps: Deps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // Storage keys and content tokens are path parameters longer than the default 100.
    routerOptions: { maxParamLength: MAX_TOKEN_LENGTH },
    logger: {
      level: config.LOG_LEVEL,
      serializers: {
        req: (req: FastifyRequest) => ({
          method: req.method,
          url: logUrl(req),
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
  // Only the store built here is ours to release; an injected one belongs to the caller.
  if (!deps.storage) app.addHook('onClose', async () => storage.destroy?.());
  app.decorate('resolverDeps', { db: deps.db, now });
  app.decorate('contentDeps', { config, storage });
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

  // Before any route: splits requests between the app host and the content host.
  registerContentOrigin(app, { config, storage, now });

  await app.register(sensible);
  await app.register(cookie, { secret: config.SESSION_SECRET });
  // Baseline headers for the app origin. The app embeds media, fonts, PDFs and frames from the
  // content origin (ADR-0002), so those directives name it; content responses replace the CSP,
  // CORP and framing headers with their own policy (http/content.ts).
  const content = config.CONTENT_ORIGIN;
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'", content],
        fontSrc: ["'self'", 'data:', content],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        frameSrc: [content],
        imgSrc: ["'self'", 'data:', 'blob:', content],
        mediaSrc: ["'self'", 'blob:', content],
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

  const routes = await loadModules(resolve(import.meta.dirname, 'http/routes'), '.routes.ts');
  for (const { file, mod } of routes) {
    if (typeof mod.default !== 'function') throw new Error(`${file} has no default export`);
    const register = mod.default as (app: FastifyInstance, deps: Deps) => void;
    await app.register(async (instance) => {
      register(instance, deps);
    });
  }

  const spa = config.STATIC_DIR ? await registerStatic(app, config.STATIC_DIR) : undefined;
  // One JSON 404 shape for unknown /api paths and non-members, in dev, tests and production.
  // The web app never answers on the content host, however the path is spelled (ADR-0002).
  app.setNotFoundHandler(
    (req, reply) =>
      (!isContentHost(req, config) && spa?.(req, reply)) || reply.code(404).send(NOT_FOUND),
  );
  return app;
}

import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import websocket from '@fastify/websocket';
import { LINK_SUBPROTOCOL, MAX_CHANNEL_FRAME_BYTES, type RouteContract } from '@parallax/contracts';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { PgBoss } from 'pg-boss';
import { BackgroundTasks } from './background';
import type { Config } from './config';
import { MAX_TOKEN_LENGTH } from './content/tokens';
import type { Db } from './db/client';
import { CONTENT_ROUTE, isContentHost, registerContentOrigin } from './http/content';
import { handleError } from './http/errors';
import { redactUrl } from './http/redact';
import { NOT_FOUND } from './http/register';
import { isApiPath, registerStatic } from './http/static';
import { createMailer, type Mailer } from './mail/mailer';
import { loadModules } from './modules';
import { emptyLinkRegistry, type LinkRegistry, LiveLinkRegistry } from './relay/links';
import { normaliseOrigin } from './relay/signing';
import { createStorage } from './storage/create';
import type { Storage } from './storage/storage';

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
  /** Job queue for routes that start background work; absent, such work is not queued. */
  boss?: PgBoss;
  /**
   * The runner's queue in schema `pgboss_exec` (docs/design/runner.md §8.4); absent, code runs
   * answer 503 and submissions queue no grading.
   */
  bossExec?: PgBoss;
  /** Work that outlives its request (mail delivery); defaults to one the server drains on close. */
  background?: BackgroundTasks;
  /**
   * `api` serves the HTTP API; `relay` serves everything `api` does plus the routes that need a
   * live connector link (`http/relay/*.routes.ts`, docs/design/connector.md §10.1). Defaults to
   * `api`.
   */
  mode?: 'api' | 'relay';
  /**
   * Live connector links. `relay` mode builds the live registry when none is injected; `api`
   * mode holds no links, so every connector reads as offline there.
   */
  links?: LinkRegistry;
}

/** What every route module receives: the injected `Deps` with the defaults buildApp resolved. */
export interface RouteDeps extends Deps {
  config: Config;
  /** The injected clock, or the system one. */
  now: () => Date;
  /** The database, or a 503 when none is configured. */
  requireDb: () => Db;
  mailer: Mailer;
  background: BackgroundTasks;
  /** The injected object store, or the one STORAGE_DRIVER selects. */
  storage: Storage;
  links: LinkRegistry;
}

/** How long close waits for background work, inside the 10 s stop grace main.ts documents. */
const BACKGROUND_CLOSE_TIMEOUT_MS = 8_000;

/** A path segment that could hold a token: encoded, or longer than any id the app routes use. */
const SUSPECT_SEGMENT = /^(?:[A-Za-z0-9._~-]{41,}|.*[^A-Za-z0-9._~-].*)$/;

/**
 * The URL as logged. Sign-in tokens (query) and content tokens (path) are credentials: the content
 * route logs no token at all. Every other path, routed or not (wildcard routes such as
 * `/assets/*`, SPA pages, near-miss spellings of a token URL such as `/content%2F<token>` or
 * `/content\<token>`), keeps its shape, with every segment that is encoded, unusual or long
 * enough to be a token replaced.
 */
export function logUrl(req: Pick<FastifyRequest, 'url'> & { routeOptions?: { url?: string } }) {
  if (req.routeOptions?.url === CONTENT_ROUTE) return '/content/[redacted]';
  const q = req.url.search(/[?#]/);
  const path = q === -1 ? req.url : req.url.slice(0, q);
  const rest = q === -1 ? '' : redactUrl(req.url.slice(q));
  const safe = path
    .split('/')
    .map((seg) => (seg !== '' && SUSPECT_SEGMENT.test(seg) ? '[redacted]' : seg))
    .join('/');
  return safe + rest;
}

export async function buildApp(config: Config, deps: Deps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // Storage keys and content tokens are path parameters longer than the default 100.
    routerOptions: { maxParamLength: MAX_TOKEN_LENGTH },
    trustProxy: config.TRUST_PROXY,
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
  // No 5xx body carries an error's text (hosts, buckets, SQL); 4xx keep Fastify's default.
  app.setErrorHandler(handleError);

  const now = deps.now ?? (() => new Date());
  const storage = deps.storage ?? createStorage(config);
  const background = deps.background ?? new BackgroundTasks(app.log);
  // Deliveries in flight get most of the 10 s stop grace (main.ts) to finish or clean up; a
  // stalled relay is abandoned then, and its row expires on its own.
  app.addHook('onClose', async () => {
    const left = await background.settled(BACKGROUND_CLOSE_TIMEOUT_MS);
    if (left > 0) app.log.warn({ left }, 'abandoning background tasks still running at close');
  });
  const relay = deps.mode === 'relay';
  const links =
    deps.links ??
    (relay && deps.db
      ? new LiveLinkRegistry({
          db: deps.db,
          origin: normaliseOrigin(config.APP_ORIGIN),
          now,
          log: app.log.child({ component: 'links' }),
        })
      : emptyLinkRegistry);
  // Links close before the server does: 1001 tells connectors to redial (§4.6).
  if (links instanceof LiveLinkRegistry) app.addHook('preClose', async () => links.closeAll());
  const routeDeps: RouteDeps = {
    ...deps,
    links,
    config,
    now,
    requireDb: () => {
      if (!deps.db) throw app.httpErrors.serviceUnavailable();
      return deps.db;
    },
    mailer: deps.mailer ?? createMailer(config, now),
    background,
    storage,
  };
  // Only the store built here is ours to release; an injected one belongs to the caller.
  if (!deps.storage) app.addHook('onClose', async () => storage.destroy?.());
  app.decorate('resolverDeps', { db: deps.db, now });
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
        frameSrc: [content, ...config.SHINY_ORIGINS],
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

  if (relay) {
    // Link messages up to max(maxControl, maxPayload + 5) bytes (§4.1), which the link enforces
    // itself, and browser-channel frames carrying a cell of up to 1 MiB (§10.5); only the link's
    // subprotocol is agreed, and its route closes a socket that did not offer it.
    const maxPayload = Math.max(
      links instanceof LiveLinkRegistry ? links.maxMessageBytes : 65541,
      MAX_CHANNEL_FRAME_BYTES,
    );
    await app.register(websocket, {
      options: {
        maxPayload,
        handleProtocols: (offered) => (offered.has(LINK_SUBPROTOCOL) ? LINK_SUBPROTOCOL : false),
      },
    });
  }

  const routes = await loadModules(resolve(import.meta.dirname, 'http/routes'), '.routes.ts');
  if (relay) {
    routes.push(...(await loadModules(resolve(import.meta.dirname, 'http/relay'), '.routes.ts')));
  }
  for (const { file, mod } of routes) {
    if (typeof mod.default !== 'function') {
      throw new Error(`${file} does not default-export a route registrar`);
    }
    const register = mod.default as (app: FastifyInstance, deps: RouteDeps) => void | Promise<void>;
    await app.register(async (instance) => {
      await register(instance, routeDeps);
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

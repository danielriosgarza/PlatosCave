import type { RateLimitOptions } from '@fastify/rate-limit';
import {
  type ErrorStatus,
  type Errors,
  errorResponses,
  type RouteContract,
  type Scope,
} from '@parallax/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { z } from 'zod';
import { type ResolverDeps, resolveScope, type ScopeFor } from '../auth/scope';
import type { Outcome } from '../outcome';
import { errorStatus } from './errors';
import { redactUrl } from './redact';

type Out<T> = T extends z.ZodType ? z.output<T> : undefined;
type BodyOf<E, S> = E extends Errors
  ? E[S & ErrorStatus] extends z.ZodType
    ? z.input<E[S & ErrorStatus]>
    : never
  : never;

/** A refusal raised inside a handler and sent with its status and body by registerRoute. */
class RouteFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`route answered ${status}`);
  }
}

/** The one 404 body: unknown paths, non-members and missing rows all answer with it. */
export const NOT_FOUND = { error: 'not found' } as const;

/**
 * 404 with the same body the scope resolver sends, so a row outside the caller's scope is
 * indistinguishable from one that does not exist (ADR-0002).
 */
export function notFound(): never {
  throw new RouteFailure(404, NOT_FOUND);
}

/**
 * Maps a service outcome to the response: the value, a 404 (same body as the resolver), a 400
 * `{ error: 'invalid', message }`, a 409 `class_archived`, or a 409 with the server copy through
 * the route's declared `conflict`. The route's contract declares whichever of these it can reach;
 * registerRoute answers 500 for any it does not.
 */
export function settle<T>(
  outcome: Outcome<T>,
  conflict?: (body: { error: 'revision_conflict'; current: T }) => never,
): T {
  if (outcome.ok) return outcome.value;
  if (outcome.reason === 'not_found') return notFound();
  if (outcome.reason === 'invalid') {
    throw new RouteFailure(400, { error: 'invalid', message: outcome.message });
  }
  if (outcome.reason === 'class_archived') throw new RouteFailure(409, { error: 'class_archived' });
  if (!conflict) throw new Error('unexpected revision conflict');
  return conflict({ error: 'revision_conflict', current: outcome.current });
}

export type RouteArgs<C> =
  C extends RouteContract<infer P, infer Q, infer B, z.ZodType, infer S, infer E>
    ? {
        params: Out<P>;
        query: Out<Q>;
        body: Out<B>;
        scope: ScopeFor<S>;
        req: FastifyRequest;
        reply: FastifyReply;
        /** Answers a status the contract declares in `errors`, with that status's body. */
        fail: <K extends keyof E & ErrorStatus>(status: K, body: BodyOf<E, K>) => never;
        /** Answers 409 with the contract's declared conflict body; `fail(409, body)` for settle. */
        conflict: (body: BodyOf<E, 409>) => never;
        /** Answers with the contract's `alternativeStatus` instead of its `status`. */
        useAlternativeStatus: () => void;
      }
    : never;

declare module 'fastify' {
  interface FastifyInstance {
    /** Set once in buildApp; registerRoute reads it to resolve scopes. */
    resolverDeps: ResolverDeps;
    /** Every contract registered through registerRoute, for the isolation matrix. */
    contracts: RouteContract[];
  }
  interface FastifyRequest {
    parallaxScope: unknown;
  }
  interface FastifyContextConfig {
    scope?: Scope;
    contract?: RouteContract;
  }
}

/** Path parameters that name a scope must be resolved by that scope, never read raw. */
function checkScopeParams(contract: RouteContract): void {
  const { path, scope } = contract;
  if (!scope?.kind) throw new Error(`${contract.method} ${path} declares no scope`);
  if (path.includes(':classId') && scope.kind !== 'class') {
    throw new Error(`${contract.method} ${path} names :classId but has scope ${scope.kind}`);
  }
  if (path.includes(':courseId') && scope.kind !== 'course') {
    throw new Error(`${contract.method} ${path} names :courseId but has scope ${scope.kind}`);
  }
  if (scope.kind === 'class' && !path.includes(':classId')) {
    throw new Error(`${contract.method} ${path} has class scope but no :classId`);
  }
  if (scope.kind === 'course' && !path.includes(':courseId')) {
    throw new Error(`${contract.method} ${path} has course scope but no :courseId`);
  }
}

/**
 * The only way to register an `/api/*` route (ADR-0002). The contract carries the scope; the
 * onRoute guard in app.ts rejects any /api route registered without one. The scope resolver
 * runs in onRequest, before body parsing and validation, so non-members get 404 and learn
 * nothing from validation errors.
 */
export function registerRoute<C extends RouteContract>(
  app: FastifyInstance,
  contract: C,
  handler: (args: RouteArgs<C>) => Promise<z.input<C['response']>> | z.input<C['response']>,
  options: {
    rateLimit?: RateLimitOptions;
    /** Largest request body in bytes, when a route takes more than Fastify's 1 MiB; needs a 413. */
    bodyLimit?: number;
  } = {},
): void {
  if (contract.websocket) {
    throw new Error(
      `${contract.method} ${contract.path} is a WebSocket; use registerWebSocketRoute()`,
    );
  }
  checkScopeParams(contract);
  if (options.rateLimit && !contract.errors?.[429]) {
    throw new Error(`${contract.method} ${contract.path} is rate limited but declares no 429`);
  }
  if (options.bodyLimit && !contract.errors?.[413]) {
    throw new Error(`${contract.method} ${contract.path} sets a body limit but declares no 413`);
  }
  const status = contract.status ?? 200;
  const answers = errorResponses(contract);
  const successes: Partial<Record<number, z.ZodType>> = { [status]: contract.response, ...answers };
  if (contract.alternativeStatus) successes[contract.alternativeStatus] = contract.response;
  // The limiter runs before the scope resolver, so an over-limit request costs no session lookup.
  // Each limiter built by app.rateLimit() has its own store, so counts are per route.
  const limiter = options.rateLimit ? app.rateLimit(options.rateLimit) : undefined;
  const resolve = scopeResolver(app, contract);
  app.route({
    method: contract.method,
    url: contract.path,
    // HEAD is off for every contract, kept global rather than per route: an implicit HEAD route
    // runs the handler, side effects included (a link checker's HEAD would use up a sign-in
    // link), and a flag each side-effecting GET had to remember would fail open. Nothing probes
    // with HEAD (Playwright and the deploy checks use GET), so HEAD on an API path answers the
    // not-found 404; isolation-matrix.itest.ts pins that.
    exposeHeadRoute: false,
    ...(options.bodyLimit && { bodyLimit: options.bodyLimit }),
    schema: {
      summary: contract.summary,
      ...(contract.params && { params: contract.params }),
      ...(contract.query && { querystring: contract.query }),
      ...(contract.body && { body: contract.body }),
      response: successes,
    },
    config: { scope: contract.scope, contract },
    onRequest: limiter ? [limiter, resolve] : resolve,
    handler: async (req, reply) => {
      reply.code(status);
      try {
        return await handler({
          params: req.params,
          query: req.query,
          body: req.body,
          scope: req.parallaxScope,
          req,
          reply,
          fail: (code: number, body: unknown) => {
            throw new RouteFailure(code, body);
          },
          conflict: (body: unknown) => {
            throw new RouteFailure(409, body);
          },
          useAlternativeStatus: () => {
            if (!contract.alternativeStatus) {
              throw new Error(`${contract.method} ${contract.path} has no alternative status`);
            }
            (reply as FastifyReply).code(contract.alternativeStatus);
          },
        } as unknown as RouteArgs<C>);
      } catch (err) {
        const failure = err instanceof RouteFailure ? err : undefined;
        const code = failure ? failure.status : errorStatus(err);
        // A status the contract does not list is a bug in the route: it is answered as one (500,
        // logged) rather than sent undocumented.
        if (code < 500 && answers[code] === undefined) {
          throw new Error(
            `${contract.method} ${contract.path} answered ${code}, which its contract does not declare`,
            { cause: err },
          );
        }
        if (!failure) throw err;
        return (reply as FastifyReply).code(failure.status).send(failure.body);
      }
    },
  });
}

/** The hook that resolves a contract's scope, answering the shared denial before the handler. */
function scopeResolver(app: FastifyInstance, contract: RouteContract) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const result = await resolveScope(req, contract.scope as Scope, app.resolverDeps);
    if (!result.ok) {
      req.log.debug({ reason: result.reason, url: redactUrl(req.url) }, 'scope denied');
      // The typed reply only knows the contract's 200 schema; denials use the shared error body.
      return reply.code(result.status).send({ error: result.error });
    }
    req.parallaxScope = result.scope;
  };
}

export type WebSocketArgs<C> =
  C extends RouteContract<infer P, infer Q, z.ZodType | undefined, z.ZodType, infer S>
    ? { params: Out<P>; query: Out<Q>; scope: ScopeFor<S>; req: FastifyRequest }
    : never;

/**
 * Registers a `websocket: true` contract (docs/design/connector.md §10.1) with
 * `@fastify/websocket`, which `relay` mode installs. The scope is resolved in `preValidation`,
 * before the upgrade: a refusal is the usual HTTP 401/403/404 and no socket is opened. A plain
 * `GET` that asks for no upgrade gets the shared 404, which is how the isolation matrix replays
 * such a contract. `handler` receives the open socket and owns it from then on.
 *
 * `beforeUpgrade` runs after the scope resolver, only for a request that asks for an upgrade; an
 * answer it sends (a status its contract declares) refuses the upgrade.
 */
export function registerWebSocketRoute<C extends RouteContract>(
  app: FastifyInstance,
  contract: C,
  handler: (socket: WebSocket, args: WebSocketArgs<C>) => void,
  options: {
    beforeUpgrade?: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  } = {},
): void {
  if (!contract.websocket) {
    throw new Error(`${contract.method} ${contract.path} is not a WebSocket; use registerRoute()`);
  }
  if (contract.method !== 'GET') throw new Error(`${contract.path}: a WebSocket route is a GET`);
  if (contract.body) throw new Error(`${contract.path}: a WebSocket route takes no body`);
  checkScopeParams(contract);
  if (!app.hasDecorator('websocketServer')) {
    throw new Error(`${contract.path}: WebSocket routes need @fastify/websocket (relay mode)`);
  }
  app.route({
    method: 'GET',
    url: contract.path,
    exposeHeadRoute: false,
    schema: {
      summary: contract.summary,
      ...(contract.params && { params: contract.params }),
      ...(contract.query && { querystring: contract.query }),
      response: errorResponses(contract),
    },
    config: { scope: contract.scope, contract },
    preValidation: [
      scopeResolver(app, contract),
      async (req: FastifyRequest, reply: FastifyReply) => {
        if (req.ws && options.beforeUpgrade) await options.beforeUpgrade(req, reply);
      },
    ],
    // Without an upgrade there is nothing to serve.
    handler: (_req, reply) => reply.code(404).send(NOT_FOUND),
    wsHandler: (socket, req) => {
      handler(socket, {
        params: req.params,
        query: req.query,
        scope: req.parallaxScope,
        req,
      } as WebSocketArgs<C>);
    },
  });
}

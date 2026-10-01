import type { RateLimitOptions } from '@fastify/rate-limit';
import type { RouteContract, Scope } from '@parallax/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { type ResolverDeps, resolveScope, type ScopeFor } from '../auth/scope';
import { redactUrl } from './redact';

type Out<T> = T extends z.ZodType ? z.output<T> : undefined;

/** A refusal raised inside a handler and sent with its status and body by registerRoute. */
class RouteFailure extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly body: unknown,
  ) {
    super(`route answered ${status}`);
  }
}

/**
 * 404 with the same body the scope resolver sends, so a row outside the caller's scope is
 * indistinguishable from one that does not exist (ADR-0002).
 */
export function notFound(): never {
  throw new RouteFailure(404, { error: 'not found' });
}

export type RouteArgs<C> =
  C extends RouteContract<infer P, infer Q, infer B, z.ZodType, infer S, infer X>
    ? {
        params: Out<P>;
        query: Out<Q>;
        body: Out<B>;
        scope: ScopeFor<S>;
        req: FastifyRequest;
        reply: FastifyReply;
        /** Answers 409 with the contract's declared conflict body. */
        conflict: (body: X extends z.ZodType ? z.input<X> : never) => never;
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
  options: { rateLimit?: RateLimitOptions } = {},
): void {
  checkScopeParams(contract);
  const status = contract.status ?? 200;
  // The limiter runs before the scope resolver, so an over-limit request costs no session lookup.
  // Each limiter built by app.rateLimit() has its own store, so counts are per route.
  const limiter = options.rateLimit ? app.rateLimit(options.rateLimit) : undefined;
  const resolve = async (req: FastifyRequest, reply: FastifyReply) => {
    const result = await resolveScope(req, contract.scope as Scope, app.resolverDeps);
    if (!result.ok) {
      req.log.debug({ reason: result.reason, url: redactUrl(req.url) }, 'scope denied');
      // The typed reply only knows the contract's 200 schema; denials use the shared error body.
      return reply.code(result.status).send({ error: result.error });
    }
    req.parallaxScope = result.scope;
  };
  app.route({
    method: contract.method,
    url: contract.path,
    // Contracts never declare HEAD: an implicit HEAD route would run the handler, side effects
    // included (a link checker's HEAD would use up a sign-in link).
    exposeHeadRoute: false,
    schema: {
      summary: contract.summary,
      ...(contract.params && { params: contract.params }),
      ...(contract.query && { querystring: contract.query }),
      ...(contract.body && { body: contract.body }),
      response: {
        [status]: contract.response,
        ...(contract.errors && { 409: contract.errors[409] }),
      },
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
          conflict: (body: unknown) => {
            if (!contract.errors) throw new Error(`${contract.path} declares no 409 body`);
            throw new RouteFailure(409, body);
          },
        } as RouteArgs<C>);
      } catch (err) {
        if (!(err instanceof RouteFailure)) throw err;
        return (reply as FastifyReply).code(err.status).send(err.body);
      }
    },
  });
}

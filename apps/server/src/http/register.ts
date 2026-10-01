import type { RateLimitOptions } from '@fastify/rate-limit';
import type { RouteContract, Scope } from '@parallax/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { type ResolverDeps, resolveScope, type ScopeFor } from '../auth/scope';

type Out<T> = T extends z.ZodType ? z.output<T> : undefined;

export type RouteArgs<C> =
  C extends RouteContract<infer P, infer Q, infer B, z.ZodType, infer S>
    ? {
        params: Out<P>;
        query: Out<Q>;
        body: Out<B>;
        scope: ScopeFor<S>;
        req: FastifyRequest;
        reply: FastifyReply;
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
  app.route({
    method: contract.method,
    url: contract.path,
    schema: {
      summary: contract.summary,
      ...(contract.params && { params: contract.params }),
      ...(contract.query && { querystring: contract.query }),
      ...(contract.body && { body: contract.body }),
      response: { [status]: contract.response },
    },
    config: {
      scope: contract.scope,
      contract,
      ...(options.rateLimit && { rateLimit: options.rateLimit }),
    },
    onRequest: async (req, reply) => {
      const result = await resolveScope(req, contract.scope as Scope, app.resolverDeps);
      if (!result.ok) {
        req.log.debug({ reason: result.reason, url: req.url }, 'scope denied');
        // The typed reply only knows the contract's 200 schema; denials use the shared error body.
        return (reply as FastifyReply).code(result.status).send({ error: result.error });
      }
      req.parallaxScope = result.scope;
    },
    handler: async (req, reply) => {
      reply.code(status);
      return handler({
        params: req.params,
        query: req.query,
        body: req.body,
        scope: req.parallaxScope,
        req,
        reply,
      } as RouteArgs<C>);
    },
  });
}

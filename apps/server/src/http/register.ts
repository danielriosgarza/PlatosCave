import type { RouteContract, Scope } from '@parallax/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { type ResolverDeps, resolveScope, type ScopeFor } from '../auth/scope';
import type { Outcome } from '../outcome';

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

/**
 * Maps a service outcome to the response: the value, a 404 (same body as the resolver), a 400
 * with the reason, or a 409 with the server copy through the route's declared `conflict`.
 */
export function settle<T>(
  outcome: Outcome<T>,
  conflict?: (body: { error: 'revision_conflict'; current: T }) => never,
): T {
  if (outcome.ok) return outcome.value;
  if (outcome.reason === 'not_found') return notFound();
  if (outcome.reason === 'invalid') {
    throw Object.assign(new Error(outcome.message), { statusCode: 400 });
  }
  if (!conflict) throw new Error('unexpected revision conflict');
  return conflict({ error: 'revision_conflict', current: outcome.current });
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
): void {
  checkScopeParams(contract);
  app.route({
    method: contract.method,
    url: contract.path,
    schema: {
      summary: contract.summary,
      ...(contract.params && { params: contract.params }),
      ...(contract.query && { querystring: contract.query }),
      ...(contract.body && { body: contract.body }),
      response: {
        200: contract.response,
        ...(contract.errors && { 409: contract.errors[409] }),
      },
    },
    config: { scope: contract.scope, contract },
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

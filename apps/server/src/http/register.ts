import type { RouteContract } from '@parallax/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

export interface RouteArgs<C extends RouteContract> {
  params: NonNullable<C['params']> extends never ? undefined : z.output<NonNullable<C['params']>>;
  query: NonNullable<C['query']> extends never ? undefined : z.output<NonNullable<C['query']>>;
  body: NonNullable<C['body']> extends never ? undefined : z.output<NonNullable<C['body']>>;
  req: FastifyRequest;
  reply: FastifyReply;
}

/**
 * The only way to register an `/api/*` route (ADR-0002). The contract carries the scope;
 * the onRoute guard in app.ts rejects any /api route registered without one.
 * Phase 0: every scope other than `public` answers 401 until the resolver lands in P1-01.
 * This check runs in the handler, after validation, only as a placeholder: P1-01 must put the
 * scope resolver in a hook that runs before validation (ADR-0002), not extend this branch.
 */
export function registerRoute<C extends RouteContract>(
  app: FastifyInstance,
  contract: C,
  handler: (args: RouteArgs<C>) => Promise<z.input<C['response']>> | z.input<C['response']>,
): void {
  app.route({
    method: contract.method,
    url: contract.path,
    schema: {
      summary: contract.summary,
      ...(contract.params && { params: contract.params }),
      ...(contract.query && { querystring: contract.query }),
      ...(contract.body && { body: contract.body }),
      response: { 200: contract.response },
    },
    config: { scope: contract.scope, contract },
    handler: async (req, reply) => {
      if (contract.scope.kind !== 'public') {
        reply.status(401 as never);
        return { error: 'scope resolution arrives in P1-01' };
      }
      return handler({
        params: req.params,
        query: req.query,
        body: req.body,
        req,
        reply,
      } as RouteArgs<C>);
    },
  });
}

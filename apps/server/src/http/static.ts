import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** True for `/api` and everything below it. */
export const isApiPath = (url: string): boolean => /^\/api(\/|\?|$)/.test(url);

/** Answers a request the router did not match, or returns undefined to fall through to 404. */
export type SpaFallback = (req: FastifyRequest, reply: FastifyReply) => FastifyReply | undefined;

/**
 * Serves the built SPA: hashed assets under /assets; the returned fallback serves index.html
 * for any other non-API GET. buildApp owns the not-found handler.
 */
export async function registerStatic(app: FastifyInstance, dir: string): Promise<SpaFallback> {
  const root = resolve(dir);
  await app.register(fastifyStatic, {
    root: resolve(root, 'assets'),
    prefix: '/assets/',
    maxAge: '1y',
    immutable: true,
  });
  return (req, reply) => {
    const read = req.method === 'GET' || req.method === 'HEAD';
    if (!read || isApiPath(req.url) || req.url.startsWith('/assets/')) return undefined;
    // cacheControl: false keeps this header from being replaced by the /assets/ cache options.
    return reply.header('cache-control', 'no-cache').sendFile('index.html', root, {
      cacheControl: false,
    });
  };
}

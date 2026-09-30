import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** True for `/api` and everything below it. */
export const isApiPath = (url: string): boolean => /^\/api(\/|\?|$)/.test(url);

/** Serves the built SPA: hashed assets under /assets, index.html for any other non-API GET. */
export async function registerStatic(app: FastifyInstance, dir: string): Promise<void> {
  const root = resolve(dir);
  await app.register(fastifyStatic, {
    root: resolve(root, 'assets'),
    prefix: '/assets/',
    maxAge: '1y',
    immutable: true,
  });
  app.setNotFoundHandler((req, reply) => {
    const read = req.method === 'GET' || req.method === 'HEAD';
    if (read && !isApiPath(req.url) && !req.url.startsWith('/assets/')) {
      // cacheControl: false keeps this header from being replaced by the /assets/ cache options.
      return reply.header('cache-control', 'no-cache').sendFile('index.html', root, {
        cacheControl: false,
      });
    }
    return reply.code(404).send({ error: 'not found' });
  });
}

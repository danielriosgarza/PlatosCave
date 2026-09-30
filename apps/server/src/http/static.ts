import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** Serves the built SPA: hashed assets under /assets, index.html for any other non-API GET. */
export async function registerStatic(app: FastifyInstance, dir: string): Promise<void> {
  const root = resolve(dir);
  await app.register(fastifyStatic, {
    root: resolve(root, 'assets'),
    prefix: '/assets/',
    maxAge: '1y',
    immutable: true,
  });
  await app.register(async (scope) => {
    await scope.register(fastifyStatic, { root, serve: false, decorateReply: false });
    scope.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.header('cache-control', 'no-cache').sendFile('index.html', root);
      }
      return reply.code(404).send({ error: 'not found' });
    });
  });
}

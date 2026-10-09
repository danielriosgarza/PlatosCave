import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Whether the caller presents the configured probe token and may see the detail. The token is the
 * only way in: no address or header heuristic, which a same-host proxy or a TCP-level proxy would
 * turn into "everyone is a probe". Compared as digests, in constant time.
 */
export function isProbe(req: FastifyRequest, token: string | undefined): boolean {
  const presented = req.headers['x-ready-token'];
  return (
    token !== undefined &&
    typeof presented === 'string' &&
    timingSafeEqual(digest(presented), digest(token))
  );
}

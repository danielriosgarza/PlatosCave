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

/**
 * The `rateLimit` option and the probe test for a route that shows its detail to probes only.
 * Callers without the token are limited per address; probes are not counted. The limiter decides
 * once per request and `isProbeRequest` reads that decision, so the limit and the body cannot
 * disagree: if the limiter never ran, nobody is a probe.
 */
export function probeLimit(token: string | undefined, max: number) {
  const probes = new WeakSet<FastifyRequest>();
  return {
    rateLimit: {
      max,
      timeWindow: '1 minute',
      allowList: (req: FastifyRequest) => {
        const probe = isProbe(req, token);
        if (probe) probes.add(req);
        return probe;
      },
    },
    isProbeRequest: (req: FastifyRequest) => probes.has(req),
  };
}

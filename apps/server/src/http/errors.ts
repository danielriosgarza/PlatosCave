import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

/** The one 5xx body: database and storage errors name hosts, buckets and SQL, and browsers read it. */
export const INTERNAL_ERROR = { error: 'internal error' } as const;

/**
 * The status Fastify's default handler would send for `err`: its `statusCode` or `status` when
 * that is an error status, otherwise 500. Classified from the error alone: `reply.statusCode` is
 * still 200 when a custom error handler runs.
 */
export function errorStatus(err: unknown): number {
  const { statusCode, status } = (err ?? {}) as { statusCode?: unknown; status?: unknown };
  const code = statusCode || status;
  return typeof code === 'number' && code >= 400 && code <= 599 ? code : 500;
}

/**
 * The server-wide error handler. 4xx are answered as Fastify's default handler answers them. A
 * 5xx is logged with the real error and answered with INTERNAL_ERROR; headers a failed response
 * had already set for its own body (a content object's disposition, range and cache lifetime)
 * are dropped, so the error body is neither saved as a download nor cached.
 */
export function handleError(err: FastifyError, req: FastifyRequest, reply: FastifyReply) {
  const status = errorStatus(err);
  if (status < 500) {
    // An Error goes on to the default handler. A thrown plain object (the rate limiter's body)
    // would be sent with status 200 if rethrown; the default handler sends it as the payload.
    if (err instanceof Error) throw err;
    const { headers } = (err ?? {}) as { headers?: Record<string, string> };
    if (headers) reply.headers(headers);
    return reply.code(status).send(err);
  }
  req.log.error({ err }, 'request failed');
  return (
    reply
      .code(status)
      .removeHeader('content-disposition')
      .removeHeader('content-range')
      // Without it, a reply that already carried the object's type refuses the object payload.
      .header('content-type', 'application/json; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(INTERNAL_ERROR)
  );
}

import type { FastifyRequest } from 'fastify';
import { readSessionToken } from '../auth/sessions';
import { hashToken } from '../auth/tokens';

/**
 * A `registerRoute` rate limit counted per session, not per address: a whole lecture hall, or a
 * load test, may come from one network address. A session comes only from a rate-limited
 * sign-in link, and a cookie that does not verify shares its address's bucket. The key is the
 * token's hash, as stored in auth_sessions, so the limiter's store never holds a live session
 * secret.
 */
export const perSession = (max: number, timeWindow: string) => ({
  rateLimit: {
    max,
    timeWindow,
    keyGenerator: (req: FastifyRequest) => {
      const token = readSessionToken(req);
      return token ? hashToken(token) : req.ip;
    },
  },
});

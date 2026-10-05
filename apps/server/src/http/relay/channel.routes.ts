import { notebookSessionChannel } from '@parallax/contracts/routes/notebookSessions';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RouteDeps } from '../../app';
import { type ClassScope, resolveScope } from '../../auth/scope';
import { findSession, type OwnedSession } from '../../db/notebooks/sessions';
import { BrowserChannel } from '../../relay/channel';
import { notebookRelays } from '../../relay/kernel';
import { LiveLinkRegistry, systemTimers } from '../../relay/links';
import { normaliseOrigin } from '../../relay/signing';
import { NOT_FOUND, registerWebSocketRoute } from '../register';

/** The request's `Origin`, normalised; undefined when absent or not an origin. */
function originOf(req: FastifyRequest): string | undefined {
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return undefined;
  try {
    return normaliseOrigin(origin);
  } catch {
    return undefined;
  }
}

/**
 * `GET /api/classes/:classId/notebook-sessions/:sessionId/channels` (docs/design/connector.md
 * §10.5): the browser's WebSocket to one of its own notebook sessions. Before the upgrade the
 * scope is resolved (non-members get the shared 404), the session must be the caller's (404
 * otherwise, the class instructor included, A33), and `Origin` must be the app's (403:
 * cross-site WebSocket hijacking). Loaded only in `relay` mode.
 */
export default function channelRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const relays = notebookRelays(app, deps);
  const appOrigin = normaliseOrigin(deps.config.APP_ORIGIN);
  const timers = deps.links instanceof LiveLinkRegistry ? deps.links.timers : systemTimers;
  // The session found before the upgrade, so the socket is served from its first message.
  const found = new WeakMap<FastifyRequest, OwnedSession>();

  registerWebSocketRoute(
    app,
    notebookSessionChannel,
    (socket, { req, params }) => {
      const session = found.get(req);
      if (!relays || !session) {
        socket.close(1011, 'unavailable');
        return;
      }
      new BrowserChannel(socket, session, {
        kernels: relays.kernels,
        timers,
        now: deps.now,
        log: req.log,
        revalidate: async () => {
          const resolved = await resolveScope(req, notebookSessionChannel.scope, {
            db: deps.db,
            now: deps.now,
          });
          if (!resolved.ok) return null;
          return findSession(deps.requireDb(), resolved.scope as ClassScope, params.sessionId);
        },
      }).start();
    },
    {
      beforeUpgrade: async (req, reply) => {
        const { sessionId } = req.params as { sessionId: string };
        const session = await findSession(
          deps.requireDb(),
          req.parallaxScope as ClassScope,
          sessionId,
        );
        if (!session) {
          await reply.code(404).send(NOT_FOUND);
          return;
        }
        if (originOf(req) !== appOrigin) {
          await reply.code(403).send({ error: 'forbidden' });
          return;
        }
        found.set(req, session);
      },
    },
  );
}

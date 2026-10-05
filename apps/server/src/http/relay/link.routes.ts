import { LINK_CLOSE, LINK_SUBPROTOCOL } from '@parallax/contracts';
import { connectorLink } from '@parallax/contracts/routes/connectors';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import { LiveLinkRegistry } from '../../relay/links';
import { registerWebSocketRoute } from '../register';

/**
 * `GET /api/connector/v1/link` (docs/design/connector.md §4): the connector's outbound
 * WebSocket. Public scope: the challenge and the Ed25519 signature authenticate it, and the
 * live-link registry runs it from the challenge to its close. Loaded only in `relay` mode.
 */
export default function linkRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const links = deps.links;
  registerWebSocketRoute(app, connectorLink, (socket, { req }) => {
    if (socket.protocol !== LINK_SUBPROTOCOL) {
      socket.close(LINK_CLOSE.protocol_error, 'protocol_error');
      return;
    }
    // Without a database no connector can authenticate: the connector redials later.
    if (!(links instanceof LiveLinkRegistry)) {
      socket.close(LINK_CLOSE.server_error, 'server_error');
      return;
    }
    links.accept(socket, req.ip);
  });
}

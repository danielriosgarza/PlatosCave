import type pg from 'pg';
import type { Db } from '../client';
import { REVOKED_CHANNEL } from './registry';

/** One connection listening for revocations; `stop` returns it. */
export interface RevocationListener {
  stop(): void;
}

export interface RevocationHandlers {
  /** A revocation of this connector id committed, in any process. */
  revoked(connectorId: string): void;
  /** The connection failed or ended; called at most once, and never after `stop`. */
  lost(err?: unknown): void;
}

/**
 * Opens a dedicated connection that listens on `REVOKED_CHANNEL` (§3). Rejects, with the
 * connection returned, when it cannot connect or listen. The connection is destroyed rather than
 * pooled when it stops, so no pooled client keeps the LISTEN.
 */
export async function listenForRevocations(
  db: Db,
  handlers: RevocationHandlers,
): Promise<RevocationListener> {
  const client: pg.PoolClient = await (db.$client as pg.Pool).connect();
  let done = false;
  const end = () => {
    if (done) return false;
    done = true;
    client.release(true);
    return true;
  };
  let listening = false;
  const lost = (err?: unknown) => {
    if (end() && listening) handlers.lost(err);
  };
  client.on('notification', (message) => {
    if (!done && message.channel === REVOKED_CHANNEL && message.payload) {
      handlers.revoked(message.payload);
    }
  });
  client.on('error', lost);
  client.on('end', () => lost());
  try {
    await client.query(`listen ${REVOKED_CHANNEL}`);
  } catch (err) {
    end();
    throw err;
  }
  if (done) throw new Error('revocation listener lost while it started');
  listening = true;
  return { stop: () => void end() };
}

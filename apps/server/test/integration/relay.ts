import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { LiveLinkRegistry } from '../../src/relay/links';
import { normaliseOrigin } from '../../src/relay/signing';
import type { Storage } from '../../src/storage/storage';
import {
  type ConnectorKey,
  FakeConnector,
  insertConnector,
  keyFromSeed,
  ManualTimers,
  seedOf,
} from '../fixtures/fake-connector';
import { buildWorld, ids, type World } from '../fixtures/world';
import type { TestDatabase } from './db';

/**
 * A listening `relay` server with a live link registry on manual timers and a fake clock, for
 * the link tests: connectors dial it over a real WebSocket.
 */
export interface Relay {
  app: FastifyInstance;
  links: LiveLinkRegistry;
  timers: ManualTimers;
  world: World;
  origin: string;
  url: string;
  /** The fake clock's time. */
  now: () => Date;
  /** Moves the fake clock and the manual timers forward together. */
  advance: (ms: number) => void;
  /** An active connector of Sam's (or of `owner`) with its own key. */
  connector: (options?: {
    status?: 'pending' | 'active' | 'revoked';
    owner?: string;
  }) => Promise<{ id: string; key: ConnectorKey }>;
  /** Opens a fake connector for `id` and `key`. */
  dial: (
    id: string,
    key: ConnectorKey,
    options?: { protocols?: string[]; origin?: string },
  ) => Promise<FakeConnector>;
  /** Waits until `check` holds, letting socket and database work run. */
  until: (check: () => boolean | Promise<boolean>, what: string) => Promise<void>;
  close: () => Promise<void>;
}

let seed = 0;

export async function startRelay(
  testDb: TestDatabase,
  start: Date,
  options: {
    minVersion?: string;
    testRoutes?: boolean;
    storage?: Storage;
    /** Further environment for the server's configuration. */
    env?: Record<string, string>;
  } = {},
): Promise<Relay> {
  let clock = start;
  const now = () => clock;
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    // Connectors dial 127.0.0.1, which is the content host by default; that host serves only
    // `/content/:token` (ADR-0002).
    CONTENT_HOST: 'content.invalid',
    ...(options.testRoutes && { TEST_ROUTES: '1' }),
    ...options.env,
  });
  const origin = normaliseOrigin(config.APP_ORIGIN);
  const timers = new ManualTimers();
  const world = await buildWorld(testDb.db, start);
  const links = new LiveLinkRegistry({
    db: testDb.db,
    origin,
    now,
    log: pino({ level: 'silent' }),
    timers,
    ...(options.minVersion && { minVersion: options.minVersion }),
  });
  const app = await buildApp(config, {
    db: testDb.db,
    now,
    mode: 'relay',
    links,
    ...(options.storage && { storage: options.storage }),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  const url = `ws://127.0.0.1:${port}/api/connector/v1/link`;

  const until = async (check: () => boolean | Promise<boolean>, what: string) => {
    for (let i = 0; i < 200; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  return {
    app,
    links,
    timers,
    world,
    origin,
    url,
    now,
    advance: (ms) => {
      clock = new Date(clock.getTime() + ms);
      timers.advance(ms);
    },
    connector: async ({ status, owner } = {}) => {
      const key = keyFromSeed(seedOf(++seed));
      const id = await insertConnector(testDb.db, {
        ownerUserId: owner ?? ids.sam,
        key,
        now: clock,
        ...(status && { status }),
      });
      return { id, key };
    },
    dial: (id, key, dialOptions = {}) =>
      FakeConnector.open({
        url,
        connectorId: id,
        key,
        origin: dialOptions.origin ?? origin,
        now: () => Math.floor(clock.getTime() / 1000),
        ...(dialOptions.protocols && { protocols: dialOptions.protocols }),
      }),
    until,
    close: () => app.close(),
  };
}

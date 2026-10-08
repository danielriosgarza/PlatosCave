import { sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { listConnectors } from '@parallax/contracts/routes/connectors';
import { deactivateAccount, deleteAccount } from '@parallax/contracts/routes/lifecycle';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { LISTEN_RETRY_MS, RECHECK_MS } from '../../src/relay/links';
import { unpairMessage } from '../../src/relay/signing';
import type { ConnectorKey } from '../fixtures/fake-connector';
import { ids } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';
import { type Relay, startRelay } from './relay';

/**
 * Production runs `api` and `relay` as two processes over one database, and the proxy sends only
 * some paths to the relay (docs/operations.md §Routing). Links live in the relay's memory, so a
 * revocation the `api` commits must still close the relay's live link at once with 4403
 * `revoked` (design §3), and every route that reads a link's presence must be routed to the
 * relay (§10.3: `online` from the live registry).
 */

const start = new Date('2026-10-01T09:00:00Z');
let testDb: TestDatabase;
let relay: Relay;
let api: FastifyInstance;

beforeAll(async () => {
  testDb = await createTestDatabase();
  relay = await startRelay(testDb, start);
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
  api = await buildApp(config, { db: testDb.db, now: relay.now, mode: 'api' });
  await api.ready();
});

afterAll(async () => {
  await api?.close();
  await relay?.close();
  await testDb?.drop();
});

async function live(owner = ids.sam) {
  const { id, key } = await relay.connector({ owner });
  const connector = await relay.dial(id, key);
  await connector.link();
  await relay.until(() => relay.links.get(id) !== undefined, 'the link to go live');
  return { id, key, connector };
}

const unpairBody = (id: string, key: ConnectorKey) => {
  const ts = Math.floor(relay.now().getTime() / 1000);
  const sig = sign(null, unpairMessage(id, ts, relay.origin), key.privateKey);
  return { connectorId: id, ts, sig: sig.toString('base64url') };
};

describe('a revocation the api process commits', () => {
  test('A27 revoking a device through the api closes its live link on the relay at once with 4403 revoked', async () => {
    const { id, connector } = await live();
    const res = await api.inject({
      method: 'POST',
      url: `/api/me/connectors/${id}/revoke`,
      headers: { cookie: relay.world.cookie.sam },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, status: 'revoked' });
    // No clock moves: the 60 s re-read cannot be what closed it.
    expect(await connector.closed).toEqual({ code: 4403, reason: 'revoked' });
    expect(relay.links.get(id)).toBeUndefined();
  });

  test('A27 an unpair the api serves closes the live link on the relay with 4403 revoked', async () => {
    const { id, key, connector } = await live();
    const res = await api.inject({
      method: 'POST',
      url: '/api/connector/v1/unpair',
      payload: unpairBody(id, key),
    });
    expect(res.json()).toEqual({ status: 'revoked' });
    expect(await connector.closed).toEqual({ code: 4403, reason: 'revoked' });
  });

  test('A33 closing an account through the api closes every live link of that person on the relay', async () => {
    const own = await live(ids.priya);
    const other = await live(ids.bea);
    const res = await api.inject({
      method: 'POST',
      url: '/api/me/deactivate',
      headers: { cookie: relay.world.cookie.priya },
      payload: { confirm: true },
    });
    expect(res.statusCode).toBe(200);
    expect(await own.connector.closed).toEqual({ code: 4403, reason: 'revoked' });
    // Another person's link is not touched.
    expect(relay.links.get(other.id)).toBeDefined();
    expect(other.connector.closeEvent).toBeUndefined();
    other.connector.close();
  });

  test('A27 a revocation committed while the relay was not listening closes the link when it listens again', async () => {
    const { id, connector } = await live();
    // The relay's listening connection is cut, so the notice below reaches nobody.
    await testDb.db.execute(
      sql`select pg_terminate_backend(pid) from pg_stat_activity
          where datname = current_database() and query ilike 'listen %'`,
    );
    const res = await api.inject({
      method: 'POST',
      url: `/api/me/connectors/${id}/revoke`,
      headers: { cookie: relay.world.cookie.sam },
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(connector.closeEvent).toBeUndefined();
    // The listener reconnects after LISTEN_RETRY_MS and re-reads every live link, well before
    // the link's own 60 s re-read.
    expect(LISTEN_RETRY_MS).toBeLessThan(RECHECK_MS);
    relay.advance(LISTEN_RETRY_MS);
    expect(await connector.closed).toEqual({ code: 4403, reason: 'revoked' });
    // And it listens again: the next revocation closes at once.
    await relay.until(async () => {
      const { rows } = await testDb.db.execute(
        sql`select 1 from pg_stat_activity
            where datname = current_database() and query ilike 'listen %'`,
      );
      return rows.length === 1;
    }, 'the listener to reconnect');
    const next = await live();
    await api.inject({
      method: 'POST',
      url: `/api/me/connectors/${next.id}/revoke`,
      headers: { cookie: relay.world.cookie.sam },
    });
    expect(await next.connector.closed).toEqual({ code: 4403, reason: 'revoked' });
  });
});

/** The `relay` row of docs/operations.md §Routing, as path patterns (`*` one segment, `…` any rest). */
function relayPaths(): RegExp[] {
  const doc = readFileSync(resolve(import.meta.dirname, '../../../../docs/operations.md'), 'utf8');
  const row = doc.split('\n').find((line) => line.includes('| `relay` (`127.0.0.1:'));
  if (!row) throw new Error('docs/operations.md has no relay routing row');
  return [...row.matchAll(/`(\/api\/[^`]*)`/g)].map(([, path]) => {
    const pattern = (path as string)
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]+')
      .replace(/…$/, '.*');
    return new RegExp(`^${pattern}$`);
  });
}

describe('routing', () => {
  test('A27 every route that reads or closes a live link is routed to the relay', () => {
    const patterns = relayPaths();
    const id = '00000000-0000-4000-8000-000000000001';
    const paths = [
      listConnectors.path,
      `/api/me/connectors/${id}/approve`,
      `/api/me/connectors/${id}/revoke`,
      `/api/me/connectors/${id}`,
      '/api/connector/v1/link',
      '/api/connector/v1/unpair',
      deactivateAccount.path,
      deleteAccount.path,
      `/api/classes/${id}/notebook-sessions`,
      `/api/me/connections/${id}/test`,
    ];
    for (const path of paths) {
      expect(
        patterns.some((p) => p.test(path)),
        `${path} is routed to the relay`,
      ).toBe(true);
    }
  });

  test('A27 the device list the relay serves shows a linked connector online', async () => {
    const { id, connector } = await live();
    const list = await relay.app.inject({
      method: 'GET',
      url: listConnectors.path,
      headers: { cookie: relay.world.cookie.sam },
    });
    expect(list.json().find((c: { id: string }) => c.id === id)).toMatchObject({ online: true });
    connector.close();
    await relay.until(() => relay.links.get(id) === undefined, 'the link to close');
    const after = await relay.app.inject({
      method: 'GET',
      url: listConnectors.path,
      headers: { cookie: relay.world.cookie.sam },
    });
    expect(after.json().find((c: { id: string }) => c.id === id)).toMatchObject({ online: false });
  });
});

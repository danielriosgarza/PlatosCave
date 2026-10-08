import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { expirePendingConnectors } from '../../src/db/connectors/registry';
import { connectors } from '../../src/db/schema';
import { defaultHello, keyFromSeed, seedOf } from '../fixtures/fake-connector';
import { ids } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';
import { type Relay, startRelay } from './relay';

/**
 * Link authentication (docs/design/connector.md §4.2, §4.6): the challenge, the signed answer,
 * `hello`, and every refusal with its close code, against a listening relay and a real
 * WebSocket. Revocation reaches a live link at once and, when that notice is lost, through the
 * 60 s re-read.
 */

const start = new Date('2026-10-01T09:00:00Z');
let testDb: TestDatabase;
let relay: Relay;

beforeAll(async () => {
  testDb = await createTestDatabase();
  relay = await startRelay(testDb, start, { testRoutes: true });
});

afterAll(async () => {
  await relay?.close();
  await testDb?.drop();
});

// Each test starts a minute later, so no test spends another's 30 link attempts a minute.
beforeEach(() => relay.advance(61_000));

const row = async (id: string) =>
  (await testDb.db.select().from(connectors).where(eq(connectors.id, id)))[0];

describe('link authentication', () => {
  test('a valid signature and hello make the link live and the connector online', async () => {
    const { id, key } = await relay.connector();
    const connector = await relay.dial(id, key);
    expect(connector.socket.protocol).toBe('parallax.connector.v1');
    const challenge = await connector.next('challenge');
    expect(challenge).toMatchObject({
      v: 1,
      origin: relay.origin,
      ts: Math.floor(relay.now().getTime() / 1000),
    });
    expect(Buffer.from(challenge.nonce as string, 'base64url')).toHaveLength(32);
    connector.send(connector.authFor(challenge));
    expect(await connector.next('auth_ok')).toEqual({
      v: 1,
      t: 'auth_ok',
      heartbeatSeconds: 15,
      limits: {
        maxStreams: 32,
        maxPayload: 65536,
        initialWindow: 262144,
        maxControl: 65536,
        maxSessions: 4,
      },
    });
    connector.send({
      v: 1,
      t: 'hello',
      version: '0.2.0',
      os: 'darwin',
      arch: 'arm64',
      mode: 'personal',
      targets: ['local'],
      features: { tty: true, agent: false, wsl: false },
      networkScope: { cidrs: ['10.20.0.0/16'], hosts: ['*.lab.example.org'] },
    });
    await relay.until(() => relay.links.get(id) !== undefined, 'the link to go live');
    expect(await row(id)).toMatchObject({
      os: 'darwin',
      arch: 'arm64',
      version: '0.2.0',
      networkScope: { cidrs: ['10.20.0.0/16'], hosts: ['*.lab.example.org'] },
      lastSeenAt: relay.now(),
    });
    const list = await relay.app.inject({
      method: 'GET',
      url: '/api/me/connectors',
      headers: { cookie: relay.world.cookie.sam },
    });
    expect(list.json().find((c: { id: string }) => c.id === id)).toMatchObject({ online: true });
    connector.close();
    await relay.until(() => relay.links.get(id) === undefined, 'the link to close');
  });

  test('a signature by another key is refused with 4401 bad_signature', async () => {
    const { id } = await relay.connector();
    const connector = await relay.dial(id, keyFromSeed(seedOf(200)));
    void connector.authenticate();
    expect(await connector.closed).toEqual({ code: 4401, reason: 'bad_signature' });
    expect(relay.links.get(id)).toBeUndefined();
  });

  test('an unknown connector id is refused like a bad signature', async () => {
    const key = keyFromSeed(seedOf(201));
    const connector = await relay.dial('3f2a6c1e-8b7d-4e5f-9a10-2c4d6e8f0a1b', key);
    void connector.authenticate();
    expect(await connector.closed).toEqual({ code: 4401, reason: 'bad_signature' });
  });

  test('a signature for another server origin is refused with 4401 bad_signature', async () => {
    const { id, key } = await relay.connector();
    const connector = await relay.dial(id, key, { origin: 'https://other.example.org' });
    void connector.authenticate();
    expect(await connector.closed).toEqual({ code: 4401, reason: 'bad_signature' });
  });

  test('a ts more than 120 s from the server clock is refused with 4401 clock_skew', async () => {
    const { id, key } = await relay.connector();
    const connector = await relay.dial(id, key);
    const old = Math.floor(relay.now().getTime() / 1000) - 121;
    void connector.authenticate({ ts: old });
    expect(await connector.closed).toEqual({ code: 4401, reason: 'clock_skew' });

    const edge = await relay.dial(id, key);
    await edge.authenticate({ ts: old + 1 });
    edge.close();
  });

  test('an answer replayed from another link fails that link’s challenge', async () => {
    const { id, key } = await relay.connector();
    const first = await relay.dial(id, key);
    const challenge = await first.next('challenge');
    const answer = first.authFor(challenge);
    first.send(answer);
    await first.next('auth_ok');

    const replay = await relay.dial(id, key);
    await replay.next('challenge');
    replay.send(answer);
    expect(await replay.closed).toEqual({ code: 4401, reason: 'bad_signature' });

    // The spent challenge cannot be answered twice on its own link either.
    first.send(answer);
    expect(await first.closed).toEqual({ code: 4400, reason: 'protocol_error' });
  });

  test('a pending connector is refused with 4403 pending', async () => {
    const { id, key } = await relay.connector({ status: 'pending' });
    const connector = await relay.dial(id, key);
    void connector.authenticate();
    expect(await connector.closed).toEqual({ code: 4403, reason: 'pending' });
  });

  test('A27 a pending connector past its approval window is refused with 4403 approval_expired, not revoked', async () => {
    const { id, key } = await relay.connector({ status: 'pending' });
    relay.advance(15 * 60_000);
    const connector = await relay.dial(id, key);
    void connector.authenticate();
    expect(await connector.closed).toEqual({ code: 4403, reason: 'approval_expired' });
  });

  test('A27 a lapsed connector the pending sweep marked revoked (expired) is still refused as approval_expired', async () => {
    const { id, key } = await relay.connector({ status: 'pending' });
    relay.advance(15 * 60_000);
    expect(await expirePendingConnectors(testDb.db, relay.now())).toContain(id);
    expect(await row(id)).toMatchObject({ status: 'revoked', revokedReason: 'expired' });
    const connector = await relay.dial(id, key);
    void connector.authenticate();
    expect(await connector.closed).toEqual({ code: 4403, reason: 'approval_expired' });
  });

  test('a revoked connector is refused with 4403 revoked', async () => {
    const { id, key } = await relay.connector({ status: 'revoked' });
    const connector = await relay.dial(id, key);
    void connector.authenticate();
    expect(await connector.closed).toEqual({ code: 4403, reason: 'revoked' });
  });

  test('a hello in another mode than the row is refused with 4403 mode_mismatch', async () => {
    const { id, key } = await relay.connector();
    const connector = await relay.dial(id, key);
    await connector.link({ mode: 'managed' });
    expect(await connector.closed).toEqual({ code: 4403, reason: 'mode_mismatch' });
    expect(relay.links.get(id)).toBeUndefined();
  });

  test('a socket without the link subprotocol is closed with 4400', async () => {
    const { id, key } = await relay.connector();
    const connector = await relay.dial(id, key, { protocols: [] });
    expect(await connector.closed).toEqual({ code: 4400, reason: 'protocol_error' });
  });

  test('a socket that does not authenticate within 10 s is closed with 4400', async () => {
    const { id, key } = await relay.connector();
    const connector = await relay.dial(id, key);
    await connector.next('challenge');
    relay.advance(9_999);
    expect(connector.closeEvent).toBeUndefined();
    relay.advance(1);
    expect(await connector.closed).toEqual({ code: 4400, reason: 'protocol_error' });
  });

  test('a message that is not a valid auth is a protocol error', async () => {
    const { id, key } = await relay.connector();
    const connector = await relay.dial(id, key);
    await connector.next('challenge');
    connector.sendRaw('{"v":1,"t":"auth"');
    expect(await connector.closed).toEqual({ code: 4400, reason: 'protocol_error' });
  });

  test('a plain GET of the link is the shared 404', async () => {
    const res = await relay.app.inject({ method: 'GET', url: '/api/connector/v1/link' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
  });

  test('the 31st link attempt from one address within a minute is closed with 4429', async () => {
    const { id, key } = await relay.connector();
    const sockets = [];
    for (let i = 0; i < 30; i++) {
      const connector = await relay.dial(id, key);
      await connector.next('challenge');
      sockets.push(connector);
    }
    const limited = await relay.dial(id, key);
    expect(await limited.closed).toEqual({ code: 4429, reason: 'rate_limited' });
    for (const s of sockets) s.close();
  });
});

describe('a live link', () => {
  async function live() {
    const { id, key } = await relay.connector();
    const connector = await relay.dial(id, key);
    await connector.link();
    await relay.until(() => relay.links.get(id) !== undefined, 'the link to go live');
    return { id, key, connector };
  }

  test('revoking the connector closes its live link at once with 4403 revoked', async () => {
    const { id, connector } = await live();
    const res = await relay.app.inject({
      method: 'POST',
      url: `/api/me/connectors/${id}/revoke`,
      headers: { cookie: relay.world.cookie.sam },
    });
    expect(res.statusCode).toBe(200);
    expect(await connector.closed).toEqual({ code: 4403, reason: 'revoked' });
    expect(relay.links.get(id)).toBeUndefined();
  });

  /** Moves 40 s on with a heartbeat, so the 45 s watchdog stays quiet (link-heartbeat.itest). */
  async function keepAlive(connector: Awaited<ReturnType<typeof live>>['connector'], seq: number) {
    relay.advance(40_000);
    connector.heartbeat(seq);
    await connector.next('heartbeat_ack');
  }

  test('a revocation whose notice was lost closes the link within 60 s', async () => {
    const { id, connector } = await live();
    // Revoked behind the registry's back: no close is sent.
    await testDb.db
      .update(connectors)
      .set({ status: 'revoked', revokedAt: relay.now(), revokedReason: 'user' })
      .where(eq(connectors.id, id));
    await keepAlive(connector, 0);
    relay.advance(19_000);
    expect(connector.closeEvent).toBeUndefined();
    relay.advance(1_000);
    expect(await connector.closed).toEqual({ code: 4403, reason: 'revoked' });
  });

  test('the re-read keeps an active connector’s link and records it as seen', async () => {
    const { id, connector } = await live();
    await keepAlive(connector, 0);
    relay.advance(20_000);
    const reread = relay.now().getTime();
    await relay.until(
      async () => (await row(id))?.lastSeenAt?.getTime() === reread,
      'the re-read to record the connector as seen',
    );
    expect(relay.links.get(id)).toBeDefined();
    expect(connector.closeEvent).toBeUndefined();
    connector.close();
  });

  test('a second link of one connector replaces the first with 4409 replaced', async () => {
    const { id, key, connector: first } = await live();
    const older = relay.links.get(id);
    const second = await relay.dial(id, key);
    await second.link();
    expect(await first.closed).toEqual({ code: 4409, reason: 'replaced' });
    await relay.until(() => relay.links.get(id) !== older, 'the newer link');
    expect(relay.links.get(id)).toBeDefined();
    expect(second.closeEvent).toBeUndefined();
    second.close();
  });

  test('a second auth or hello on a live link is a protocol error', async () => {
    const { connector } = await live();
    connector.send(defaultHello);
    expect(await connector.closed).toEqual({ code: 4400, reason: 'protocol_error' });
  });

  test('revokeUserConnectors closes every live link of the person', async () => {
    const { revokeUserConnectors } = await import('../../src/relay/links');
    const a = await relay.connector({ owner: ids.bea });
    const linkA = await relay.dial(a.id, a.key);
    await linkA.link();
    await relay.until(() => relay.links.get(a.id) !== undefined, 'the link to go live');
    const revoked = await revokeUserConnectors(testDb.db, relay.links, ids.bea, relay.now());
    expect(revoked).toEqual([a.id]);
    expect(await linkA.closed).toEqual({ code: 4403, reason: 'revoked' });
  });
});

describe('connector fixture routes (TEST_ROUTES=1)', () => {
  const post = (url: string, who: 'sam' | 'bea' | 'marcus') =>
    relay.app.inject({ method: 'POST', url, headers: { cookie: relay.world.cookie[who] } });

  test('the owner approves a pending connector through the approval service', async () => {
    // Marcus holds no other connector, so the limit of five active ones is not in the way.
    const { id, key } = await relay.connector({ status: 'pending', owner: ids.marcus });
    expect((await post(`/api/test/connectors/${id}/approve`, 'bea')).statusCode).toBe(404);
    const res = await post(`/api/test/connectors/${id}/approve`, 'marcus');
    expect(res.json()).toEqual({ status: 'active' });
    expect(await row(id)).toMatchObject({ status: 'active', approvedAt: relay.now() });
    const connector = await relay.dial(id, key);
    await connector.link();
    await relay.until(() => relay.links.get(id) !== undefined, 'the link to go live');
    connector.close();
  });

  test('drop-link closes the owner’s live link so the connector redials', async () => {
    const { id, key } = await relay.connector();
    const connector = await relay.dial(id, key);
    await connector.link();
    await relay.until(() => relay.links.get(id) !== undefined, 'the link to go live');
    const foreign = await post(`/api/test/connectors/${id}/drop-link`, 'bea');
    expect(foreign.statusCode).toBe(404);
    expect(relay.links.get(id)).toBeDefined();
    expect((await post(`/api/test/connectors/${id}/drop-link`, 'sam')).json()).toEqual({
      dropped: true,
    });
    expect(await connector.closed).toEqual({ code: 1001, reason: '' });
    expect((await post(`/api/test/connectors/${id}/drop-link`, 'sam')).json()).toEqual({
      dropped: false,
    });
  });
});

describe('a minimum connector version', () => {
  test('a hello below minVersion is refused with 4426 upgrade_required', async () => {
    const strictDb = await createTestDatabase();
    const strict = await startRelay(strictDb, start, { minVersion: '0.2.0' });
    try {
      const { id, key } = await strict.connector();
      const old = await strict.dial(id, key);
      const ok = await old.link({ version: '0.2.0-rc.1' });
      expect(ok).toMatchObject({ minVersion: '0.2.0' });
      expect(await old.closed).toEqual({ code: 4426, reason: 'upgrade_required' });

      const current = await strict.dial(id, key);
      await current.link({ version: '0.2.0' });
      await strict.until(() => strict.links.get(id) !== undefined, 'the link to go live');
      current.close();
    } finally {
      await strict.close();
      await strictDb.drop();
    }
  });
});

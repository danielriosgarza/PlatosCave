import { generateKeyPairSync, sign } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { createSession } from '../../src/db/auth/sessions';
import { createPairing, pairingKey } from '../../src/db/connectors/pairing';
import { revokeUserConnectors } from '../../src/db/connectors/registry';
import { auditEvents, connectorPairings, connectors } from '../../src/db/schema';
import { purgeConnectorPairings } from '../../src/jobs/maintenance';
import type { Link, LinkRegistry } from '../../src/relay/links';
import { normaliseOrigin, pollMessage, unpairMessage } from '../../src/relay/signing';
import { asUserScope, buildWorld, cookieFor, ids, type PersonName } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

const start = new Date('2026-10-01T09:00:00Z');
let clock = start;
const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const origin = normaliseOrigin(config.APP_ORIGIN);
const key = pairingKey(config.SESSION_SECRET);

/** Links the routes close, recorded; link-auth.itest.ts runs the real registry. */
const closed: { connectorId: string; code: number; reason: string }[] = [];
const fakeLinks: LinkRegistry = {
  get: (connectorId) =>
    ({
      connectorId,
      close: (code: number, reason: string) => void closed.push({ connectorId, code, reason }),
    }) as Partial<Link> as Link,
};

let testDb: TestDatabase;
let app: FastifyInstance;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await buildWorld(testDb.db, start);
  app = await buildApp(config, { db: testDb.db, now: () => clock, links: fakeLinks });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

/** Each test uses its own address, so per-address limits of one test do not reach another. */
let addressSeq = 0;
const nextAddress = () => `10.0.0.${++addressSeq}`;

const later = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

/** A session authenticated now, so approval's recent-sign-in check passes. */
async function freshCookie(who: PersonName) {
  const { token } = await createSession(testDb.db, ids[who], { now: clock });
  return cookieFor(token);
}

async function as(
  who: PersonName,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: object,
) {
  const res = await app.inject({
    method,
    url,
    headers: { cookie: await freshCookie(who) },
    ...(payload && { payload }),
  });
  return { status: res.statusCode, body: res.json() };
}

/** A connector's identity: an Ed25519 key and the requests it signs. */
function device() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x as string;
  const signed = (
    kind: 'poll' | 'unpair',
    connectorId: string,
    ts = Math.floor(clock.getTime() / 1000),
  ) => {
    const build = kind === 'poll' ? pollMessage : unpairMessage;
    const sig = sign(null, build(connectorId, ts, origin), privateKey).toString('base64url');
    return { connectorId, ts, sig };
  };
  return { publicKey: raw, signed };
}

async function pairWith(
  code: string,
  dev: ReturnType<typeof device>,
  address: string,
  name = 'Laptop',
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/connector/v1/pair',
    remoteAddress: address,
    payload: { code, publicKey: dev.publicKey, name, os: 'linux', arch: 'amd64', version: '0.1.0' },
  });
  return { status: res.statusCode, body: res.json() };
}

async function signedPost(path: 'pair/poll' | 'unpair', body: object, address = nextAddress()) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/connector/v1/${path}`,
    remoteAddress: address,
    payload: body,
  });
  return { status: res.statusCode, body: res.json() };
}

/** Issues a code for `who` directly, without the per-person creation limit of the route. */
async function codeFor(who: PersonName) {
  const { code } = await createPairing(testDb.db, asUserScope(ids[who], ''), key, clock);
  return code;
}

/** A pending connector of `who`. */
async function pending(who: PersonName, name = 'Laptop') {
  const dev = device();
  const res = await pairWith(await codeFor(who), dev, nextAddress(), name);
  expect(res.status).toBe(201);
  return { dev, id: res.body.connectorId as string, fingerprint: res.body.fingerprint as string };
}

/** An active connector of `who`. */
async function active(who: PersonName, name = 'Laptop') {
  const made = await pending(who, name);
  const res = await as(who, 'POST', `/api/me/connectors/${made.id}/approve`);
  expect(res.status).toBe(200);
  return made;
}

const row = async (id: string) =>
  (await testDb.db.select().from(connectors).where(eq(connectors.id, id)))[0];
const events = (id: string) =>
  testDb.db
    .select({ action: auditEvents.action, actorId: auditEvents.actorId, after: auditEvents.after })
    .from(auditEvents)
    .where(and(eq(auditEvents.targetType, 'connector'), eq(auditEvents.targetId, id)))
    .orderBy(auditEvents.createdAt);

describe('connector pairing', () => {
  test('pairing happy path through poll', async () => {
    const created = await as('bea', 'POST', '/api/me/connectors/pairings');
    expect(created.status).toBe(201);
    expect(created.body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(created.body.expiresAt).toBe(new Date(start.getTime() + 10 * 60_000).toISOString());

    const dev = device();
    // The CLI sends the code normalised; the server also accepts what the person typed.
    const paired = await pairWith(
      created.body.code.toLowerCase(),
      dev,
      nextAddress(),
      'Bea laptop',
    );
    expect(paired.status).toBe(201);
    expect(paired.body).toMatchObject({ status: 'pending', pollAfterSeconds: 2 });
    expect(paired.body.approveBy).toBe(new Date(clock.getTime() + 15 * 60_000).toISOString());
    const { connectorId, fingerprint } = paired.body;
    expect(fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);

    const listed = await as('bea', 'GET', '/api/me/connectors');
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      expect.objectContaining({
        id: connectorId,
        name: 'Bea laptop',
        os: 'linux',
        arch: 'amd64',
        version: '0.1.0',
        fingerprint,
        status: 'pending',
        mode: 'personal',
        approveBy: paired.body.approveBy,
        networkScope: { cidrs: [], hosts: [] },
      }),
    ]);

    const waiting = await signedPost('pair/poll', dev.signed('poll', connectorId));
    expect(waiting).toEqual({ status: 200, body: { status: 'pending', pollAfterSeconds: 2 } });

    const approved = await as('bea', 'POST', `/api/me/connectors/${connectorId}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ id: connectorId, status: 'active', approveBy: null });

    later(1000);
    const done = await signedPost('pair/poll', dev.signed('poll', connectorId));
    expect(done).toEqual({ status: 200, body: { status: 'active' } });
    expect((await row(connectorId))?.lastSeenAt).toEqual(clock);

    // The code is spent: a second connector cannot use it.
    expect((await pairWith(created.body.code, device(), nextAddress())).status).toBe(404);
    const actions = (await events(connectorId)).map((e) => [e.action, e.actorId]);
    expect(actions).toEqual([
      ['connector.paired', ids.bea],
      ['connector.approved', ids.bea],
    ]);
  });

  test('A33 a foreign connector id is a 404 for approve, revoke, rename and list', async () => {
    const own = await pending('bea', 'Bea desktop');
    const before = await row(own.id);
    // Sam is another student; Marcus teaches Bea's class; Elena owns the course.
    for (const who of ['sam', 'marcus', 'elena'] as const) {
      for (const [method, url, payload] of [
        ['POST', `/api/me/connectors/${own.id}/approve`, undefined],
        ['POST', `/api/me/connectors/${own.id}/revoke`, undefined],
        ['PATCH', `/api/me/connectors/${own.id}`, { name: 'Taken' }],
      ] as const) {
        const res = await as(who, method, url, payload);
        expect(res, `${who} ${method} ${url}`).toEqual({
          status: 404,
          body: { error: 'not found' },
        });
      }
      const listed = await as(who, 'GET', '/api/me/connectors');
      expect(listed.status).toBe(200);
      expect(listed.body.map((c: { id: string }) => c.id)).not.toContain(own.id);
    }
    // An id that exists nowhere answers the same.
    const unknown = await as('sam', 'POST', `/api/me/connectors/${ids.statistics}/approve`);
    expect(unknown).toEqual({ status: 404, body: { error: 'not found' } });
    expect(await row(own.id)).toEqual(before);
  });

  test('expired, reused and malformed codes answer one body', async () => {
    const expired = await codeFor('sam');
    later(10 * 60_000);
    const reused = await codeFor('sam');
    expect((await pairWith(reused, device(), nextAddress())).status).toBe(201);
    const answers = [];
    for (const code of [expired, reused, 'NOT-A-CODE', 'K7M2-Q9XU', '']) {
      answers.push(await pairWith(code, device(), nextAddress()));
    }
    for (const answer of answers)
      expect(answer).toEqual({ status: 404, body: { error: 'not found' } });
  });

  test('a client address is blocked for ten minutes after ten failed codes', async () => {
    const address = nextAddress();
    for (let i = 0; i < 10; i++) {
      expect((await pairWith('ZZZZ-ZZZZ', device(), address)).status).toBe(404);
    }
    const good = await codeFor('marcus');
    const blocked = await pairWith(good, device(), address);
    expect(blocked.status).toBe(429);
    // Another address is not affected, and the blocked one is let in again after ten minutes.
    expect((await pairWith(good, device(), nextAddress())).status).toBe(201);
    later(10 * 60_000);
    expect((await pairWith(await codeFor('marcus'), device(), address)).status).toBe(201);
  });

  test('a person may create five pairing codes an hour, and holds at most three live ones', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await as('olivia', 'POST', '/api/me/connectors/pairings')).status);
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
    // Of the five issued, only the three newest are live.
    const live = await testDb.db
      .select()
      .from(connectorPairings)
      .where(eq(connectorPairings.ownerUserId, ids.olivia));
    expect(live.filter((p) => p.expiresAt > clock)).toHaveLength(3);

    const first = await codeFor('ines');
    for (let i = 0; i < 3; i++) {
      later(1000);
      await codeFor('ines');
    }
    expect((await pairWith(first, device(), nextAddress())).status).toBe(404);
  });

  test('recent authentication is required to approve', async () => {
    const made = await pending('bea');
    const { token } = await createSession(testDb.db, ids.bea, {
      now: clock,
      authTime: new Date(clock.getTime() - 16 * 60_000),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/me/connectors/${made.id}/approve`,
      headers: { cookie: cookieFor(token) },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'recent_auth_required' });
    expect((await row(made.id))?.status).toBe('pending');
  });

  test('a preview principal gets 403 on every connector route', async () => {
    const made = await pending('marcus');
    for (const [method, url, payload] of [
      ['POST', '/api/me/connectors/pairings', undefined],
      ['GET', '/api/me/connectors', undefined],
      ['POST', `/api/me/connectors/${made.id}/approve`, undefined],
      ['POST', `/api/me/connectors/${made.id}/revoke`, undefined],
      ['PATCH', `/api/me/connectors/${made.id}`, { name: 'Preview' }],
    ] as const) {
      const res = await as('previewB', method, url, payload);
      expect(res, `${method} ${url}`).toEqual({ status: 403, body: { error: 'forbidden' } });
    }
    expect((await row(made.id))?.status).toBe('pending');
  });

  test('revoke while pending rejects the device', async () => {
    const made = await pending('bea');
    const res = await as('bea', 'POST', `/api/me/connectors/${made.id}/revoke`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: made.id, status: 'revoked', approveBy: null });
    expect(await row(made.id)).toMatchObject({ status: 'revoked', revokedReason: 'rejected' });
    expect(await signedPost('pair/poll', made.dev.signed('poll', made.id))).toEqual({
      status: 200,
      body: { status: 'rejected' },
    });
    const approve = await as('bea', 'POST', `/api/me/connectors/${made.id}/approve`);
    expect(approve).toEqual({ status: 409, body: { error: 'not_pending' } });
    const listed = await as('bea', 'GET', '/api/me/connectors');
    expect(listed.body.map((c: { id: string }) => c.id)).not.toContain(made.id);
  });

  test('revoke closes nothing yet but records revoked_reason', async () => {
    const made = await active('priya');
    closed.length = 0;
    const res = await as('priya', 'POST', `/api/me/connectors/${made.id}/revoke`);
    expect(res.body).toMatchObject({ status: 'revoked' });
    expect(await row(made.id)).toMatchObject({
      status: 'revoked',
      revokedReason: 'user',
      revokedAt: clock,
    });
    expect(closed).toEqual([{ connectorId: made.id, code: 4403, reason: 'revoked' }]);
    expect((await events(made.id)).at(-1)).toMatchObject({
      action: 'connector.revoked',
      actorId: ids.priya,
      after: { status: 'revoked', reason: 'user' },
    });
    // Revoking again changes nothing and closes nothing.
    closed.length = 0;
    expect((await as('priya', 'POST', `/api/me/connectors/${made.id}/revoke`)).status).toBe(200);
    expect(closed).toEqual([]);
    expect((await events(made.id)).filter((e) => e.action === 'connector.revoked')).toHaveLength(1);
  });

  test('at most 5 active and 3 pending connectors', async () => {
    const who = 'noor';
    const first = await pending(who);
    await pending(who);
    await pending(who);
    const code = await codeFor(who);
    const fourth = await pairWith(code, device(), nextAddress());
    expect(fourth).toEqual({ status: 429, body: { error: 'too_many_pending' } });
    // The refusal did not spend the code: rejecting one device makes room for it.
    await as(who, 'POST', `/api/me/connectors/${first.id}/revoke`);
    expect((await pairWith(code, device(), nextAddress())).status).toBe(201);

    const listed = (await as(who, 'GET', '/api/me/connectors')).body as { id: string }[];
    for (const c of listed) {
      expect((await as(who, 'POST', `/api/me/connectors/${c.id}/approve`)).status).toBe(200);
    }
    await active(who);
    await active(who);
    const sixth = await pending(who);
    const refused = await as(who, 'POST', `/api/me/connectors/${sixth.id}/approve`);
    expect(refused).toEqual({ status: 409, body: { error: 'too_many_connectors' } });
    expect((await row(sixth.id))?.status).toBe('pending');
  });

  test('an unapproved connector expires at approve_by', async () => {
    const made = await pending('sam');
    later(15 * 60_000);
    expect(await signedPost('pair/poll', made.dev.signed('poll', made.id))).toEqual({
      status: 200,
      body: { status: 'expired' },
    });
    expect(await row(made.id)).toMatchObject({ status: 'revoked', revokedReason: 'expired' });
    const approve = await as('sam', 'POST', `/api/me/connectors/${made.id}/approve`);
    expect(approve).toEqual({ status: 409, body: { error: 'not_pending' } });
  });

  test('a poll needs a valid signature, a current ts and at most one request a second', async () => {
    const made = await pending('sam');
    const other = device();
    const ts = Math.floor(clock.getTime() / 1000);
    const refusals = [
      other.signed('poll', made.id), // another key
      made.dev.signed('poll', made.id, ts - 121), // too old
      made.dev.signed('unpair', made.id), // another label
      { ...made.dev.signed('poll', made.id), connectorId: ids.statistics }, // unknown id
    ];
    for (const body of refusals) {
      expect(await signedPost('pair/poll', body)).toEqual({
        status: 404,
        body: { error: 'not found' },
      });
    }
    expect((await signedPost('pair/poll', made.dev.signed('poll', made.id))).status).toBe(200);
    expect((await signedPost('pair/poll', made.dev.signed('poll', made.id))).status).toBe(429);
    later(1000);
    expect((await signedPost('pair/poll', made.dev.signed('poll', made.id))).status).toBe(200);
  });

  test('a signed unpair revokes the connector for its owner', async () => {
    const made = await active('bea');
    closed.length = 0;
    expect((await signedPost('unpair', made.dev.signed('poll', made.id))).status).toBe(404);
    const res = await signedPost('unpair', made.dev.signed('unpair', made.id));
    expect(res).toEqual({ status: 200, body: { status: 'revoked' } });
    expect(await row(made.id)).toMatchObject({ status: 'revoked', revokedReason: 'unpair' });
    expect(closed).toEqual([{ connectorId: made.id, code: 4403, reason: 'revoked' }]);
    expect((await events(made.id)).at(-1)).toMatchObject({
      action: 'connector.revoked',
      actorId: ids.bea,
      after: { reason: 'unpair' },
    });
    later(1000);
    expect((await signedPost('pair/poll', made.dev.signed('poll', made.id))).body).toEqual({
      status: 'rejected',
    });
  });

  test('a key that is already paired cannot pair again', async () => {
    const made = await pending('ines');
    const res = await pairWith(await codeFor('ines'), made.dev, nextAddress());
    expect(res).toEqual({ status: 400, body: { error: 'key_in_use' } });
  });

  test('rename changes the name and refuses control characters', async () => {
    const made = await pending('ines');
    const res = await as('ines', 'PATCH', `/api/me/connectors/${made.id}`, { name: 'Lab box' });
    expect(res).toMatchObject({ status: 200, body: { id: made.id, name: 'Lab box' } });
    const bad = await as('ines', 'PATCH', `/api/me/connectors/${made.id}`, { name: 'Lab\u0007' });
    expect(bad.status).toBe(400);
    expect((await row(made.id))?.name).toBe('Lab box');
  });

  test('revokeUserConnectors revokes every pending and active connector of one person', async () => {
    const a = await active('olivia');
    const p = await pending('olivia');
    const revoked = await revokeUserConnectors(testDb.db, ids.olivia, clock);
    expect(revoked.sort()).toEqual([a.id, p.id].sort());
    for (const id of [a.id, p.id]) {
      expect(await row(id)).toMatchObject({ status: 'revoked', revokedReason: 'account' });
      expect((await events(id)).at(-1)).toMatchObject({
        action: 'connector.revoked',
        actorId: null,
      });
    }
  });

  test('the maintenance job purges used and expired pairings and expires lapsed approvals', async () => {
    const made = await pending('elena');
    await codeFor('elena');
    later(15 * 60_000);
    const live = await codeFor('elena');
    const result = await purgeConnectorPairings(testDb.db, clock);
    expect(result.purged).toBeGreaterThanOrEqual(2);
    expect(result.expired).toBeGreaterThanOrEqual(1);
    const left = await testDb.db.select().from(connectorPairings);
    expect(left.every((p) => p.usedAt === null && p.expiresAt > clock)).toBe(true);
    expect(left).toHaveLength(1);
    expect(await row(made.id)).toMatchObject({ status: 'revoked', revokedReason: 'expired' });
    expect((await pairWith(live, device(), nextAddress())).status).toBe(201);
  });
});

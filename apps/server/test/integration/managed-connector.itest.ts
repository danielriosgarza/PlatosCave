import { generateKeyPairSync, sign } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { createSession } from '../../src/db/auth/sessions';
import { registerManagedConnector } from '../../src/db/connectors/managed';
import { auditEvents, connectors } from '../../src/db/schema';
import { authenticateLink, Challenge, checkHello } from '../../src/relay/auth';
import type { LinkRegistry } from '../../src/relay/links';
import { fingerprintOf, linkMessage, normaliseOrigin } from '../../src/relay/signing';
import { buildWorld, cookieFor, ids, people } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

const now = new Date('2026-10-07T09:00:00Z');
const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const noLinks: LinkRegistry = { get: () => undefined };

let testDb: TestDatabase;
let app: FastifyInstance;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await buildWorld(testDb.db, now);
  app = await buildApp(config, { db: testDb.db, now: () => now, links: noLinks });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

const identity = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  return { raw, privateKey };
};

describe('managed connector registration (design §12)', () => {
  test('inserts an active managed row with no owner, once per key', async () => {
    const key = identity();
    const result = await registerManagedConnector(
      testDb.db,
      { name: 'HPC login', publicKey: key.raw },
      now,
    );
    if (!result.ok) throw new Error(`registration refused: ${result.reason}`);
    expect(result.fingerprint).toBe(fingerprintOf(key.raw));
    const [row] = await testDb.db
      .select()
      .from(connectors)
      .where(eq(connectors.id, result.connectorId));
    expect(row).toMatchObject({
      ownerUserId: null,
      name: 'HPC login',
      mode: 'managed',
      status: 'active',
      approvedAt: now,
      approveBy: null,
      revokedAt: null,
    });
    const events = await testDb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.targetId, result.connectorId));
    expect(events).toMatchObject([
      { action: 'connector.paired', scopeKind: 'system', scopeId: null, actorId: null },
    ]);

    expect(
      await registerManagedConnector(testDb.db, { name: 'Again', publicKey: key.raw }, now),
    ).toEqual({ ok: false, reason: 'key_in_use' });

    // The connector links with its key, and only in managed mode.
    const challenge = new Challenge(now);
    const ts = Math.floor(now.getTime() / 1000);
    const origin = normaliseOrigin(config.APP_ORIGIN);
    const sig = sign(
      null,
      linkMessage(challenge.nonce, result.connectorId, ts, origin),
      key.privateKey,
    ).toString('base64url');
    const auth = await authenticateLink(
      testDb.db,
      challenge,
      { connectorId: result.connectorId, ts, sig },
      origin,
      now,
    );
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    expect(checkHello(auth.connector, { mode: 'managed', version: '0.1.0' }, undefined)).toBe(null);
    expect(checkHello(auth.connector, { mode: 'personal', version: '0.1.0' }, undefined)).toBe(
      'mode_mismatch',
    );
  });

  test("a managed row is invisible to every person's GET /api/me/connectors", async () => {
    const key = identity();
    const result = await registerManagedConnector(
      testDb.db,
      { name: 'Shared lab', publicKey: key.raw },
      now,
    );
    if (!result.ok) throw new Error(`registration refused: ${result.reason}`);
    for (const who of people) {
      const { token } = await createSession(testDb.db, ids[who], { now });
      const headers = { cookie: cookieFor(token) };
      const listed = await app.inject({ method: 'GET', url: '/api/me/connectors', headers });
      if (listed.statusCode === 200) {
        expect(
          listed.json().map((c: { id: string }) => c.id),
          who,
        ).not.toContain(result.connectorId);
      } else {
        // A preview principal is refused the user routes altogether.
        expect(listed.statusCode, who).toBe(403);
        expect(listed.body).not.toContain(result.connectorId);
      }
      for (const [method, url, payload] of [
        ['POST', `/api/me/connectors/${result.connectorId}/approve`, undefined],
        ['POST', `/api/me/connectors/${result.connectorId}/revoke`, undefined],
        ['PATCH', `/api/me/connectors/${result.connectorId}`, { name: 'Mine now' }],
      ] as const) {
        const res = await app.inject({ method, url, headers, ...(payload && { payload }) });
        expect([403, 404], `${who} ${method} ${url}`).toContain(res.statusCode);
      }
    }
    const [row] = await testDb.db
      .select({ name: connectors.name, status: connectors.status })
      .from(connectors)
      .where(eq(connectors.id, result.connectorId));
    expect(row).toEqual({ name: 'Shared lab', status: 'active' });
  });
});

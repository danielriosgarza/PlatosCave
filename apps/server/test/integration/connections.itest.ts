import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import {
  auditEvents,
  classComputeTemplates,
  connectors,
  notebookConnections,
  notebookSessions,
} from '../../src/db/schema';
import { insertConnector, keyFromSeed, seedOf } from '../fixtures/fake-connector';
import { buildWorld, ids, type PersonName, type World } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';
import { insertNotebook } from './notebook-sessions';

/**
 * Saved connections (docs/design/connector.md §2, §10.3): create, rename, the host keys a PATCH
 * drops, archive refused while a session is open, another person's connector, and template use.
 */

const now = new Date('2026-10-01T09:00:00Z');
const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;
let samConnector: string;
let beaConnector: string;
let pendingConnector: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, now);
  app = await buildApp(config, { db: testDb.db, now: () => now });
  await app.ready();
  samConnector = await insertConnector(testDb.db, {
    ownerUserId: ids.sam,
    key: keyFromSeed(seedOf(201)),
    now,
  });
  beaConnector = await insertConnector(testDb.db, {
    ownerUserId: ids.bea,
    key: keyFromSeed(seedOf(202)),
    now,
  });
  pendingConnector = await insertConnector(testDb.db, {
    ownerUserId: ids.sam,
    key: keyFromSeed(seedOf(203)),
    status: 'pending',
    now,
  });
  // The connector reported a lab network it may reach (§8).
  await testDb.db
    .update(connectors)
    .set({ networkScope: { cidrs: ['10.20.0.0/16'], hosts: [] } })
    .where(eq(connectors.id, samConnector));
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

async function as(
  who: PersonName,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
) {
  const res = await app.inject({
    method,
    url,
    headers: { cookie: world.cookie[who] },
    ...(payload && { payload }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: assertions walk the response freely.
  return { status: res.statusCode, body: res.json() as any };
}

const sshTarget = (host = 'login.cluster.example.org', extra: object = {}) => ({
  kind: 'ssh',
  host,
  port: 22,
  user: 'sam',
  auth: { method: 'key', keyPath: '~/.ssh/id_ed25519' },
  workspace: '/home/sam/parallax',
  ...extra,
});

let named = 0;
const create = (who: PersonName, body: object = {}) =>
  as(who, 'POST', '/api/me/connections', {
    name: `Connection ${++named}`,
    connectorId: samConnector,
    target: sshTarget(),
    runtime: { mode: 'start', kernelName: 'python3' },
    ...body,
  });

describe('saved connections', () => {
  test('create stores a secret-free reference and audits it without the key path', async () => {
    const res = await create('sam', { name: 'Lab workstation' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Lab workstation',
      connectorId: samConnector,
      target: sshTarget(),
      trustedHostKeys: [],
      templateId: null,
      archivedAt: null,
    });
    const list = await as('sam', 'GET', '/api/me/connections');
    expect(list.body.map((c: { id: string }) => c.id)).toContain(res.body.id);
    const [event] = await testDb.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, 'connection.created'), eq(auditEvents.targetId, res.body.id)),
      );
    expect(event).toMatchObject({ scopeKind: 'user', scopeId: ids.sam, actorId: ids.sam });
    expect(JSON.stringify(event?.after)).not.toContain('id_ed25519');
  });

  test('a field for a secret does not exist', async () => {
    const res = await create('sam', {
      target: sshTarget(undefined, { auth: { method: 'key', keyPath: '~/k', password: 'x' } }),
    });
    expect(res.status).toBe(400);
  });

  test('names are unique per person among unarchived connections', async () => {
    expect((await create('sam', { name: 'Twice' })).status).toBe(201);
    expect(await create('sam', { name: 'twice' })).toMatchObject({
      status: 409,
      body: { error: 'name_taken' },
    });
  });

  test('a target breaking the rules of §4.4 or outside the reported scope is refused', async () => {
    expect(await create('sam', { target: sshTarget('169.254.169.254') })).toMatchObject({
      status: 400,
      body: { error: 'target_not_allowed', code: 'invalid_target', rules: [2] },
    });
    expect(
      await create('sam', { target: sshTarget(undefined, { workspace: 'parallax' }) }),
    ).toMatchObject({ status: 400, body: { code: 'invalid_target', rules: [3] } });
    expect(await create('sam', { target: sshTarget('192.168.1.10') })).toMatchObject({
      status: 400,
      body: { error: 'target_not_allowed', code: 'network_scope_denied' },
    });
    expect((await create('sam', { target: sshTarget('10.20.1.5') })).status).toBe(201);
  });

  test("A33 another person's connector is a 404 and a pending one is not active", async () => {
    expect(await create('sam', { connectorId: beaConnector })).toMatchObject({
      status: 404,
      body: { error: 'not found' },
    });
    expect(await create('sam', { connectorId: pendingConnector })).toMatchObject({
      status: 409,
      body: { error: 'connector_not_active' },
    });
  });

  test("A33 another person's connection is a 404 for read, change and archive", async () => {
    const own = await create('sam');
    for (const [method, payload] of [
      ['GET', undefined],
      ['PATCH', { name: 'Mine now' }],
      ['DELETE', undefined],
    ] as const) {
      for (const who of ['bea', 'priya', 'elena'] as const) {
        const res = await as(who, method, `/api/me/connections/${own.body.id}`, payload);
        expect(res, `${who} ${method}`).toMatchObject({
          status: 404,
          body: { error: 'not found' },
        });
      }
    }
    const preview = await as('previewB', 'GET', `/api/me/connections/${own.body.id}`);
    expect(preview.status).toBe(403);
  });

  test('rename keeps the host keys; a new host or jump host drops the keys it no longer names', async () => {
    const jump = { host: 'bastion.example.org', port: 2222, user: 'sam' };
    const created = await create('sam', { target: sshTarget(undefined, { jump }) });
    const id = created.body.id as string;
    const keys = [
      { host: 'login.cluster.example.org', port: 22, sha256: `SHA256:${'a'.repeat(43)}` },
      { host: 'bastion.example.org', port: 2222, sha256: `SHA256:${'b'.repeat(43)}` },
    ].map((k) => ({ ...k, confirmedAt: now.toISOString() }));
    await testDb.db
      .update(notebookConnections)
      .set({ trustedHostKeys: keys })
      .where(eq(notebookConnections.id, id));

    const renamed = await as('sam', 'PATCH', `/api/me/connections/${id}`, { name: 'Cluster' });
    expect(renamed.body).toMatchObject({ name: 'Cluster', trustedHostKeys: keys });

    const newUser = await as('sam', 'PATCH', `/api/me/connections/${id}`, {
      target: sshTarget(undefined, { jump, user: 'sam2' }),
    });
    expect(newUser.body.trustedHostKeys).toEqual(keys);

    const newJump = await as('sam', 'PATCH', `/api/me/connections/${id}`, {
      target: sshTarget(undefined, { jump: { ...jump, port: 22 } }),
    });
    expect(newJump.body.trustedHostKeys).toEqual([keys[0]]);

    const newHost = await as('sam', 'PATCH', `/api/me/connections/${id}`, {
      target: sshTarget('other.example.org'),
    });
    expect(newHost.status).toBe(200);
    expect(newHost.body.trustedHostKeys).toEqual([]);

    const refused = await as('sam', 'PATCH', `/api/me/connections/${id}`, {
      target: sshTarget('10.99.0.1'),
    });
    expect(refused).toMatchObject({ status: 400, body: { code: 'network_scope_denied' } });
  });

  test('archive is refused with 409 in_use while a session is open, then archives', async () => {
    const created = await create('sam');
    const id = created.body.id as string;
    const revisionId = await insertNotebook(testDb.db, now);
    const [session] = await testDb.db
      .insert(notebookSessions)
      .values({
        classId: ids.classA,
        userId: ids.sam,
        connectionId: id,
        connectorId: samConnector,
        resourceRevisionId: revisionId,
        state: 'ready',
        owned: true,
        runtime: { mode: 'start' },
        lease: { idleTimeoutMin: 30, gracePeriodMin: 5 },
      })
      .returning({ id: notebookSessions.id });
    expect(await as('sam', 'DELETE', `/api/me/connections/${id}`)).toMatchObject({
      status: 409,
      body: { error: 'in_use', sessionId: session?.id },
    });
    await testDb.db
      .update(notebookSessions)
      .set({ state: 'stopped', cause: 'user_stop', stoppedAt: now })
      .where(eq(notebookSessions.id, session?.id as string));
    const archived = await as('sam', 'DELETE', `/api/me/connections/${id}`);
    expect(archived.status).toBe(200);
    expect(archived.body.archivedAt).toBe(now.toISOString());
    expect((await as('sam', 'GET', `/api/me/connections/${id}`)).status).toBe(404);
    // The name is free again once archived.
    expect((await create('sam', { name: created.body.name })).status).toBe(201);
  });

  test('a template of a class the person is not in is a 404', async () => {
    const [template] = await testDb.db
      .insert(classComputeTemplates)
      .values({
        classId: ids.classB,
        name: 'Cluster',
        description: 'The department cluster',
        target: { host: 'login.cluster.example.org', port: 22, workspace: '/home/{user}/parallax' },
        runtime: { mode: 'start' },
        isolation: 'account',
        hostOwnerConfirmedBy: ids.marcus,
        hostOwnerConfirmedAt: now,
        createdBy: ids.marcus,
      })
      .returning({ id: classComputeTemplates.id });
    const templateId = template?.id as string;
    expect(await create('sam', { templateId })).toMatchObject({ status: 404 });
    const bea = await create('bea', { connectorId: beaConnector, templateId });
    expect(bea.status).toBe(201);
    expect(bea.body.templateId).toBe(templateId);
  });
});

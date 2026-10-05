import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { auditEvents, classComputeTemplates, classes } from '../../src/db/schema';
import { insertConnector, keyFromSeed, seedOf } from '../fixtures/fake-connector';
import { buildWorld, ids, type PersonName, type World } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

/**
 * Class host templates (docs/design/connector.md §11; spec §10.3, §13): instructors publish,
 * change and archive them after a recent sign-in with the host-owner statement; every member
 * reads them; a template carries no credential, and a learner's connection from it holds the
 * learner's own account, is audited as `template.used`, and is refused outside the class.
 */

const start = new Date('2026-10-01T09:00:00Z');
const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
let clock = start;
let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;
const connector: Partial<Record<PersonName, string>> = {};

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, start);
  app = await buildApp(config, { db: testDb.db, now: () => clock });
  await app.ready();
  let seed = 300;
  for (const who of ['sam', 'bea', 'priya'] as const) {
    connector[who] = await insertConnector(testDb.db, {
      ownerUserId: ids[who],
      key: keyFromSeed(seedOf(++seed)),
      now: start,
    });
  }
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

// Every test starts within the sign-in's recent window unless it moves the clock itself.
beforeEach(() => {
  clock = start;
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

const templates = (classId: string) => `/api/classes/${classId}/compute-templates`;

const cluster = {
  name: 'Department cluster',
  description: 'Each student signs in with their own university account.',
  target: {
    host: 'jupyter.cluster.example.org',
    port: 22,
    jump: { host: 'gateway.example.org', port: 2222 },
    workspace: '/home/{user}/parallax',
  },
  runtime: { mode: 'start', kernelName: 'python3' },
  isolation: 'account',
  lease: { idleTimeoutMin: 60, gracePeriodMin: 10 },
  hostOwnerConfirmed: true,
};

let published = 0;
/** Marcus, class B's instructor, publishes a template there; resolves with its id. */
async function publish(extra: object = {}): Promise<string> {
  const res = await as('marcus', 'POST', templates(ids.classB), {
    ...cluster,
    name: `${cluster.name} ${++published}`,
    ...extra,
  });
  if (res.status !== 201) throw new Error(`publish: ${JSON.stringify(res.body)}`);
  return res.body.id;
}

/** The target a template of `cluster` makes for `user`. */
const derived = (user: string, auth: object = { method: 'agent', hint: 'cluster' }) => ({
  kind: 'ssh',
  host: 'jupyter.cluster.example.org',
  port: 22,
  user,
  auth,
  workspace: `/home/${user}/parallax`,
  jump: { host: 'gateway.example.org', port: 2222, user, auth },
});

let named = 0;
const connect = (who: 'sam' | 'bea' | 'priya', templateId: string, target: object) =>
  as(who, 'POST', '/api/me/connections', {
    name: `From template ${++named}`,
    connectorId: connector[who],
    target,
    runtime: { mode: 'start', kernelName: 'python3' },
    templateId,
  });

const eventsFor = (action: string, targetId: string) =>
  testDb.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, targetId)));

describe('class host templates', () => {
  test('A33 a template carries no credentials and cannot be used in another class', async () => {
    // The template's target has no field for a user, a key, a token or a home directory.
    for (const extra of [
      { user: 'marcus' },
      { auth: { method: 'key', keyPath: '~/.ssh/id_ed25519' } },
      { token: 'secret' },
    ]) {
      const res = await as('marcus', 'POST', templates(ids.classB), {
        ...cluster,
        target: { ...cluster.target, ...extra },
      });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    const jumpUser = await as('marcus', 'POST', templates(ids.classB), {
      ...cluster,
      target: { ...cluster.target, jump: { ...cluster.target.jump, user: 'marcus' } },
    });
    expect(jumpUser.status).toBe(400);

    const templateId = await publish();
    const read = await as('bea', 'GET', templates(ids.classB));
    const view = read.body.find((t: { id: string }) => t.id === templateId);
    expect(Object.keys(view.target).sort()).toEqual(['host', 'jump', 'port', 'workspace']);
    expect(view.target.jump).toEqual({ host: 'gateway.example.org', port: 2222 });
    expect(JSON.stringify(view)).not.toMatch(/marcus|keyPath|token|hint/i);

    // Bea, a student of class B, makes her own connection with her own account and agent hint.
    const bea = await connect('bea', templateId, derived('bea'));
    expect(bea.status, JSON.stringify(bea.body)).toBe(201);
    expect(bea.body).toMatchObject({ templateId, target: derived('bea') });

    // Sam studies only in class A: class B's template is the shared 404 to him, and he cannot
    // list it either.
    expect(await connect('sam', templateId, derived('sam'))).toMatchObject({ status: 404 });
    expect((await as('sam', 'GET', templates(ids.classB))).status).toBe(404);

    // A connection naming the template must hold exactly the template's host and workspace.
    for (const target of [
      { ...derived('bea'), host: 'elsewhere.example.org' },
      { ...derived('bea'), workspace: '/home/marcus/parallax' },
      { ...derived('bea'), jump: undefined },
      { ...derived('bea'), port: 2200 },
    ]) {
      expect(await connect('bea', templateId, target)).toMatchObject({
        status: 400,
        body: { error: 'target_not_allowed', code: 'template_mismatch' },
      });
    }
    // An agent identity must be named: a template host never sees every key in the agent.
    expect(await connect('bea', templateId, derived('bea', { method: 'agent' }))).toMatchObject({
      status: 400,
      body: { code: 'template_mismatch' },
    });

    // Nor can the connection be moved off the template's host later.
    const moved = await as('bea', 'PATCH', `/api/me/connections/${bea.body.id}`, {
      target: { ...derived('bea'), host: 'elsewhere.example.org' },
    });
    expect(moved).toMatchObject({ status: 400, body: { code: 'template_mismatch' } });
    // A different account of the learner's own is still the template's target.
    const key = { method: 'key', keyPath: '~/.ssh/cluster_ed25519' };
    const renamed = await as('bea', 'PATCH', `/api/me/connections/${bea.body.id}`, {
      target: derived('bea.lindqvist', key),
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.target.workspace).toBe('/home/bea.lindqvist/parallax');
  });

  test('instructor writes and every member reads', async () => {
    const created = await as('marcus', 'POST', templates(ids.classB), {
      ...cluster,
      name: 'GPU nodes',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      classId: ids.classB,
      name: 'GPU nodes',
      target: cluster.target,
      runtime: cluster.runtime,
      isolation: 'account',
      lease: cluster.lease,
      hostOwnerConfirmedAt: start.toISOString(),
      archivedAt: null,
    });
    const id = created.body.id;
    for (const who of ['marcus', 'bea', 'priya', 'previewB'] as const) {
      const list = await as(who, 'GET', templates(ids.classB));
      expect(list.status, who).toBe(200);
      expect(
        list.body.map((t: { id: string }) => t.id),
        who,
      ).toContain(id);
    }
    // Class A's members see only class A's templates.
    expect((await as('priya', 'GET', templates(ids.classA))).body).toEqual([]);

    const changed = await as('marcus', 'PATCH', `${templates(ids.classB)}/${id}`, {
      name: 'GPU nodes (A100)',
      isolation: 'allocation',
      lease: null,
      hostOwnerConfirmed: true,
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({
      name: 'GPU nodes (A100)',
      isolation: 'allocation',
      lease: null,
      target: cluster.target,
    });
    // The host is fixed: another host is another template.
    const moved = await as('marcus', 'PATCH', `${templates(ids.classB)}/${id}`, {
      target: { ...cluster.target, host: 'other.example.org' },
      hostOwnerConfirmed: true,
    });
    expect(moved.status).toBe(400);

    const archived = await as('marcus', 'DELETE', `${templates(ids.classB)}/${id}`);
    expect(archived.status).toBe(200);
    expect(archived.body.archivedAt).toBe(start.toISOString());
    const after = await as('bea', 'GET', templates(ids.classB));
    expect(after.body.map((t: { id: string }) => t.id)).not.toContain(id);
    expect((await as('marcus', 'DELETE', `${templates(ids.classB)}/${id}`)).status).toBe(404);
    // No new connection is made from an archived template.
    expect(await connect('bea', id, derived('bea'))).toMatchObject({ status: 404 });
  });

  test('the host-owner statement and a recent sign-in are required', async () => {
    const { hostOwnerConfirmed: _, ...unconfirmed } = cluster;
    for (const body of [unconfirmed, { ...cluster, hostOwnerConfirmed: false }]) {
      expect((await as('marcus', 'POST', templates(ids.classB), body)).status).toBe(400);
    }
    const id = await publish();
    const patch = await as('marcus', 'PATCH', `${templates(ids.classB)}/${id}`, { name: 'x' });
    expect(patch.status).toBe(400);

    clock = new Date(start.getTime() + 16 * 60_000);
    const stale = await as('marcus', 'POST', templates(ids.classB), cluster);
    expect(stale).toMatchObject({ status: 401, body: { code: 'recent_auth_required' } });
    expect(
      await as('marcus', 'PATCH', `${templates(ids.classB)}/${id}`, {
        name: 'Renamed',
        hostOwnerConfirmed: true,
      }),
    ).toMatchObject({ status: 401 });
    expect(await as('marcus', 'DELETE', `${templates(ids.classB)}/${id}`)).toMatchObject({
      status: 401,
    });
    // Reading needs no recent sign-in.
    expect((await as('bea', 'GET', templates(ids.classB))).status).toBe(200);
  });

  test('a template its connections would break is refused when published', async () => {
    const refused = (target: object, isolation = 'account') =>
      as('marcus', 'POST', templates(ids.classB), { ...cluster, target, isolation });
    expect(await refused({ ...cluster.target, workspace: 'parallax/{user}' })).toMatchObject({
      status: 400,
      body: { error: 'target_not_allowed', code: 'invalid_target', rules: [3] },
    });
    // One directory for every learner of a host isolated by OS account.
    expect(await refused({ ...cluster.target, workspace: '/srv/parallax' })).toMatchObject({
      status: 400,
      body: { code: 'workspace_needs_user' },
    });
    // A container per learner may share a path.
    const container = await refused({ ...cluster.target, workspace: '/srv/parallax' }, 'container');
    expect(container.status, JSON.stringify(container.body)).toBe(201);
    // Moving that template to an account per learner would point every learner at one directory.
    const reisolated = await as(
      'marcus',
      'PATCH',
      `${templates(ids.classB)}/${container.body.id}`,
      {
        isolation: 'account',
        hostOwnerConfirmed: true,
      },
    );
    expect(reisolated).toMatchObject({
      status: 400,
      body: { error: 'target_not_allowed', code: 'workspace_needs_user' },
    });
    const [kept] = await testDb.db
      .select()
      .from(classComputeTemplates)
      .where(eq(classComputeTemplates.id, container.body.id));
    expect(kept?.isolation).toBe('container');
    expect(
      (
        await as('marcus', 'POST', templates(ids.classB), {
          ...cluster,
          runtime: { mode: 'attach', port: 8888 },
        })
      ).status,
    ).toBe(400);
  });

  test('students cannot write templates', async () => {
    const id = await publish();
    // Bea is a student of class B; Priya studies in B and teaches A; the preview is a student.
    // Members are refused with 403 (ADR-0002); a non-member gets the shared 404.
    for (const who of ['bea', 'priya', 'previewB'] as const) {
      expect((await as(who, 'POST', templates(ids.classB), cluster)).status, who).toBe(403);
      expect(
        (
          await as(who, 'PATCH', `${templates(ids.classB)}/${id}`, {
            name: 'Mine',
            hostOwnerConfirmed: true,
          })
        ).status,
        who,
      ).toBe(403);
      expect((await as(who, 'DELETE', `${templates(ids.classB)}/${id}`)).status, who).toBe(403);
    }
    expect((await as('sam', 'POST', templates(ids.classB), cluster)).status).toBe(404);
    // An instructor of another class cannot reach this class's template through their own.
    expect(
      (
        await as('priya', 'PATCH', `${templates(ids.classA)}/${id}`, {
          name: 'Mine',
          hostOwnerConfirmed: true,
        })
      ).status,
    ).toBe(404);
    const [row] = await testDb.db
      .select()
      .from(classComputeTemplates)
      .where(eq(classComputeTemplates.id, id));
    expect(row?.archivedAt).toBeNull();
    expect(row?.name).toBe(`${cluster.name} ${published}`);
  });

  test('publishing, changing, using and archiving are audited in the class', async () => {
    const id = await publish();
    const [publishedEvent] = await eventsFor('template.published', id);
    expect(publishedEvent).toMatchObject({
      actorId: ids.marcus,
      scopeKind: 'class',
      scopeId: ids.classB,
      before: null,
    });
    const used = await connect('priya', id, derived('priya'));
    expect(used.status, JSON.stringify(used.body)).toBe(201);
    const [usedEvent] = await eventsFor('template.used', id);
    expect(usedEvent).toMatchObject({
      actorId: ids.priya,
      scopeKind: 'class',
      scopeId: ids.classB,
      after: { connectionId: used.body.id },
    });
    // The learner's account and credential reference stay out of the class's audit trail.
    expect(JSON.stringify(usedEvent)).not.toMatch(/\/home\/priya|hint|auth/);

    await as('marcus', 'PATCH', `${templates(ids.classB)}/${id}`, {
      description: 'Now with GPUs',
      hostOwnerConfirmed: true,
    });
    const changes = await eventsFor('template.published', id);
    expect(changes).toHaveLength(2);
    await as('marcus', 'DELETE', `${templates(ids.classB)}/${id}`);
    const [archivedEvent] = await eventsFor('template.archived', id);
    expect(archivedEvent).toMatchObject({ actorId: ids.marcus, scopeId: ids.classB });
  });

  test('an archived class keeps its templates readable and refuses writes', async () => {
    const id = await publish();
    await testDb.db.update(classes).set({ archivedAt: start }).where(eq(classes.id, ids.classB));
    try {
      expect((await as('bea', 'GET', templates(ids.classB))).status).toBe(200);
      expect(await as('marcus', 'POST', templates(ids.classB), cluster)).toMatchObject({
        status: 409,
        body: { error: 'class_archived' },
      });
      expect(await as('marcus', 'DELETE', `${templates(ids.classB)}/${id}`)).toMatchObject({
        status: 409,
      });
    } finally {
      await testDb.db.update(classes).set({ archivedAt: null }).where(eq(classes.id, ids.classB));
    }
  });
});

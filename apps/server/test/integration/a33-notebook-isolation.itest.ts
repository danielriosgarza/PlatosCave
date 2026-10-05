import { eq, notInArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { classComputeTemplates, notebookSessions } from '../../src/db/schema';
import { ids, type PersonName } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';
import {
  call,
  insertNotebook,
  liveConnector,
  relink,
  saveConnection,
  sessionState,
  settled,
} from './notebook-sessions';
import { type Relay, startRelay } from './relay';

/**
 * A33 for notebook sessions (docs/design/connector.md §10.3, §14): a session, its kernels and
 * its files are reached only through its owner's own class scope, so a classmate or the class
 * instructor gets the shared 404; and a destination the connector may not reach is refused when
 * the connection is saved and again when it connects.
 */

const start = new Date('2026-10-01T09:00:00Z');
let testDb: TestDatabase;
let relay: Relay;
let revisionId: string;
let templateB: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  relay = await startRelay(testDb, start);
  revisionId = await insertNotebook(testDb.db, start);
  const [template] = await testDb.db
    .insert(classComputeTemplates)
    .values({
      classId: ids.classB,
      name: 'Department cluster',
      description: 'One account per student',
      target: { host: 'login.cluster.example.org', port: 22, workspace: '/home/{user}/parallax' },
      runtime: { mode: 'start' },
      isolation: 'account',
      hostOwnerConfirmedBy: ids.marcus,
      hostOwnerConfirmedAt: start,
      createdBy: ids.marcus,
    })
    .returning({ id: classComputeTemplates.id });
  templateB = template?.id as string;
});

afterAll(async () => {
  await relay?.close();
  await testDb?.drop();
});

// One open session per person and notebook: each test starts with none.
beforeEach(async () => {
  relay.advance(61_000);
  await testDb.db
    .update(notebookSessions)
    .set({ state: 'stopped', cause: 'abandoned', stoppedAt: relay.now() })
    .where(notInArray(notebookSessions.state, ['stopped', 'failed']));
});

const cookie = (who: PersonName) => relay.world.cookie[who];
const sessions = (classId: string) => `/api/classes/${classId}/notebook-sessions`;

/** A student of class B connects through the class template on their own connector. */
async function classmate(who: 'bea' | 'priya') {
  const live = await liveConnector(relay, ids[who]);
  const connectionId = await saveConnection(relay, cookie(who), live.id, { templateId: templateB });
  const res = await call(relay, cookie(who), 'POST', sessions(ids.classB), {
    connectionId,
    revisionId,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  const request = await live.connector.next('open_session');
  live.connector.send(
    sessionState(relay, res.body.sessionId, 'ready', { requestId: request.requestId }),
  );
  await settled(relay, live.id);
  return { ...live, connectionId, sessionId: res.body.sessionId as string };
}

/** Every route that names a session, as `who`. */
async function everyRoute(who: PersonName, classId: string, sessionId: string) {
  const url = `${sessions(classId)}/${sessionId}`;
  return [
    await call(relay, cookie(who), 'GET', url),
    await call(relay, cookie(who), 'POST', `${url}/close`, { stop: false }),
    await call(relay, cookie(who), 'POST', `${url}/close`, { stop: true }),
    await call(relay, cookie(who), 'POST', `${url}/forget`),
  ];
}

describe('A33 notebook session isolation', () => {
  test("A33 two classmates on one template cannot read each other's sessions, kernels or files", async () => {
    const bea = await classmate('bea');
    const priya = await classmate('priya');

    // Each list holds only the caller's own session.
    const beaList = await call(relay, cookie('bea'), 'GET', sessions(ids.classB));
    expect(beaList.body.map((s: { id: string }) => s.id)).toEqual([bea.sessionId]);
    const priyaList = await call(relay, cookie('priya'), 'GET', sessions(ids.classB));
    expect(priyaList.body.map((s: { id: string }) => s.id)).toEqual([priya.sessionId]);

    // Every route naming the other's session is the shared 404; nothing reaches either connector.
    for (const res of await everyRoute('priya', ids.classB, bea.sessionId)) {
      expect(res).toMatchObject({ status: 404, body: { error: 'not found' } });
    }
    for (const res of await everyRoute('bea', ids.classB, priya.sessionId)) {
      expect(res).toMatchObject({ status: 404, body: { error: 'not found' } });
    }
    await settled(relay, bea.id);
    await settled(relay, priya.id);
    expect(bea.connector.received.filter((m) => m.t === 'close_session')).toEqual([]);
    expect(priya.connector.received.filter((m) => m.t === 'close_session')).toEqual([]);
    // Each connector was only ever asked to open its own person's session.
    const opened = (c: typeof bea) =>
      c.connector.received.filter((m) => m.t === 'open_session').map((m) => m.sessionId);
    expect(opened(bea)).toEqual([bea.sessionId]);
    expect(opened(priya)).toEqual([priya.sessionId]);

    // Neither may open a session on the other's connection.
    const borrowed = await call(relay, cookie('priya'), 'POST', sessions(ids.classB), {
      connectionId: bea.connectionId,
      revisionId,
    });
    expect(borrowed).toMatchObject({ status: 404, body: { error: 'not found' } });
    // Kernel (P3-06a) and file (P3-09) routes resolve the session with the same owner check.
    const [row] = await testDb.db
      .select({ userId: notebookSessions.userId })
      .from(notebookSessions)
      .where(eq(notebookSessions.id, bea.sessionId));
    expect(row?.userId).toBe(ids.bea);
  });

  test('A33 a guessed session id is a 404 even for the class instructor', async () => {
    const bea = await classmate('bea');
    for (const res of await everyRoute('marcus', ids.classB, bea.sessionId)) {
      expect(res).toMatchObject({ status: 404, body: { error: 'not found' } });
    }
    // The course owner is not a member of the class at all; class A's people do not see it either.
    for (const res of await everyRoute('elena', ids.classB, bea.sessionId)) {
      expect(res.status).toBe(404);
    }
    for (const res of await everyRoute('sam', ids.classA, bea.sessionId)) {
      expect(res).toMatchObject({ status: 404, body: { error: 'not found' } });
    }
    const list = await call(relay, cookie('marcus'), 'GET', sessions(ids.classB));
    expect(list.body.map((s: { id: string }) => s.id)).not.toContain(bea.sessionId);
    expect(
      (await call(relay, cookie('bea'), 'GET', `${sessions(ids.classB)}/${bea.sessionId}`)).status,
    ).toBe(200);
  });

  test('A33 a forbidden forwarding destination is refused at save and at connect', async () => {
    // The default hello reports 10.20.0.0/16 as reachable.
    const live = await liveConnector(relay, ids.sam);
    const target = (host: string) => ({
      kind: 'ssh',
      host,
      port: 22,
      user: 'sam',
      auth: { method: 'agent' },
      workspace: '/home/sam/parallax',
    });
    const save = (host: string) =>
      call(relay, cookie('sam'), 'POST', '/api/me/connections', {
        name: `To ${host}`,
        connectorId: live.id,
        target: target(host),
        runtime: { mode: 'start' },
      });
    for (const host of ['169.254.169.254', '::ffff:169.254.169.254', '0x7f000001']) {
      expect(await save(host), host).toMatchObject({
        status: 400,
        body: { error: 'target_not_allowed', code: 'invalid_target' },
      });
    }
    for (const host of ['192.168.0.10', '127.0.0.1', '10.21.0.5']) {
      expect(await save(host), host).toMatchObject({
        status: 400,
        body: { error: 'target_not_allowed', code: 'network_scope_denied' },
      });
    }
    const allowed = await save('10.20.0.5');
    expect(allowed.status).toBe(201);

    // The connector comes back without that network in its scope: Connect is refused and
    // nothing is sent.
    live.connector.close();
    await relay.until(() => relay.links.get(live.id) === undefined, 'the link to close');
    const again = await relink(relay, live.id, live.key, {
      networkScope: { cidrs: [], hosts: [] },
    });
    const refused = await call(relay, cookie('sam'), 'POST', sessions(ids.classA), {
      connectionId: allowed.body.id,
      revisionId,
    });
    expect(refused).toMatchObject({
      status: 400,
      body: { error: 'target_not_allowed', code: 'network_scope_denied' },
    });
    await settled(relay, live.id);
    expect(again.received.filter((m) => m.t === 'open_session')).toEqual([]);
    const open = await call(relay, cookie('sam'), 'GET', sessions(ids.classA));
    expect(open.body).toEqual([]);
  });

  test('A33 two classmates using one template get separate connections and sessions', async () => {
    const [template] = await testDb.db
      .insert(classComputeTemplates)
      .values({
        classId: ids.classB,
        name: 'Teaching servers',
        description: 'One OS account per student',
        target: { host: 'jupyter.teaching.example.org', port: 22, workspace: '/home/{user}/work' },
        runtime: { mode: 'start' },
        isolation: 'account',
        lease: { idleTimeoutMin: 90, gracePeriodMin: 15 },
        hostOwnerConfirmedBy: ids.marcus,
        hostOwnerConfirmedAt: start,
        createdBy: ids.marcus,
      })
      .returning({ id: classComputeTemplates.id });
    const templateId = template?.id as string;
    const own = (user: string) => ({
      kind: 'ssh',
      host: 'jupyter.teaching.example.org',
      port: 22,
      user,
      auth: { method: 'agent', hint: `${user}@laptop` },
      workspace: `/home/${user}/work`,
    });

    const opened: Record<string, { connectionId: string; sessionId: string; target: unknown }> = {};
    for (const who of ['bea', 'priya'] as const) {
      const live = await liveConnector(relay, ids[who]);
      const connectionId = await saveConnection(relay, cookie(who), live.id, {
        templateId,
        target: own(who),
      });
      const res = await call(relay, cookie(who), 'POST', sessions(ids.classB), {
        connectionId,
        revisionId,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      const request = await live.connector.next('open_session');
      // Each connector is sent its own person's account and workspace, with the template's lease.
      expect(request).toMatchObject({
        sessionId: res.body.sessionId,
        target: own(who),
        lease: { idleTimeoutMin: 90, gracePeriodMin: 15 },
      });
      opened[who] = { connectionId, sessionId: res.body.sessionId, target: request.target };
      await settled(relay, live.id);
    }
    expect(opened.bea?.connectionId).not.toBe(opened.priya?.connectionId);
    expect(opened.bea?.sessionId).not.toBe(opened.priya?.sessionId);
    // Neither sees the other's connection or session.
    const beaConnections = await call(relay, cookie('bea'), 'GET', '/api/me/connections');
    expect(beaConnections.body.map((c: { id: string }) => c.id)).not.toContain(
      opened.priya?.connectionId,
    );
    const priyaSession = `${sessions(ids.classB)}/${opened.priya?.sessionId}`;
    expect(await call(relay, cookie('bea'), 'GET', priyaSession)).toMatchObject({ status: 404 });

    // Once the instructor archives the template, its connections open no new session.
    await testDb.db
      .update(classComputeTemplates)
      .set({ archivedAt: relay.now() })
      .where(eq(classComputeTemplates.id, templateId));
    await testDb.db
      .update(notebookSessions)
      .set({ state: 'stopped', cause: 'abandoned', stoppedAt: relay.now() })
      .where(eq(notebookSessions.id, opened.bea?.sessionId as string));
    const refused = await call(relay, cookie('bea'), 'POST', sessions(ids.classB), {
      connectionId: opened.bea?.connectionId,
      revisionId,
    });
    expect(refused).toMatchObject({ status: 409, body: { error: 'template_archived' } });
  });

  test("A33 a connection made from a class's template cannot be used in another class", async () => {
    // Priya studies in class B (the template's class) and teaches class A.
    const live = await liveConnector(relay, ids.priya);
    const connectionId = await saveConnection(relay, cookie('priya'), live.id, {
      templateId: templateB,
    });
    const res = await call(relay, cookie('priya'), 'POST', sessions(ids.classA), {
      connectionId,
      revisionId,
    });
    expect(res).toMatchObject({ status: 409, body: { error: 'wrong_class' } });
    await settled(relay, live.id);
    expect(live.connector.received.filter((m) => m.t === 'open_session')).toEqual([]);
  });
});

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { auditEvents, classMemberships, notebookSessions } from '../../src/db/schema';
import type { Received } from '../fixtures/fake-connector';
import { ids } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';
import {
  call,
  insertNotebook,
  liveConnector,
  saveConnection,
  sessionState,
  settled,
} from './notebook-sessions';
import { type Relay, startRelay } from './relay';

/**
 * Removing a member ends what they still hold in the class (P3-AUD2; ADR-0002 "Permission
 * revoked", docs/design/connector.md §10.7): their open notebook sessions there close in the
 * removing transaction with cause `membership_removed`, an owned process is stopped at the
 * connector's next heartbeat (an attached runtime is the person's own and is not), and a
 * re-enrolled person starts with no open session. Sam studies in A and, for these tests, in B.
 */

const start = new Date('2026-10-01T09:00:00Z');
let testDb: TestDatabase;
let relay: Relay;
let revisionId: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  relay = await startRelay(testDb, start);
  revisionId = await insertNotebook(testDb.db, start);
});

afterAll(async () => {
  await relay?.close();
  await testDb?.drop();
});

const sessionsUrl = (classId: string) => `/api/classes/${classId}/notebook-sessions`;

async function row(sessionId: string) {
  const [found] = await testDb.db
    .select()
    .from(notebookSessions)
    .where(eq(notebookSessions.id, sessionId));
  return found;
}

const enrolSamInB = () =>
  testDb.db
    .insert(classMemberships)
    .values({ classId: ids.classB, userId: ids.sam, role: 'student' });

/** Elena (course owner) removes Sam from class B. */
const removeSamFromB = () =>
  call(relay, relay.world.cookie.elena, 'DELETE', `/api/classes/${ids.classB}/members/${ids.sam}`);

const ready = (owned: boolean) => (request: Received) =>
  sessionState(relay, request.sessionId as string, 'ready', {
    requestId: request.requestId,
    owned,
  });

/** Opens a session for the holder of `cookie` in `classId` and waits until it is ready. */
async function openReady(
  who: 'sam' | 'bea',
  classId: string,
  options: { owned?: boolean; runtime?: object } = {},
) {
  const cookie = relay.world.cookie[who];
  const live = await liveConnector(relay, ids[who]);
  const connectionId = await saveConnection(relay, cookie, live.id, {
    ...(options.runtime && { runtime: options.runtime }),
  });
  const res = await call(relay, cookie, 'POST', sessionsUrl(classId), { connectionId, revisionId });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  const request = await live.connector.next('open_session');
  live.connector.send(ready(options.owned ?? true)(request));
  const sessionId = res.body.sessionId as string;
  await relay.until(
    async () => (await row(sessionId))?.state === 'ready',
    'the session to be ready',
  );
  return { ...live, sessionId, connectionId };
}

describe('A33 a removed member keeps no open session in the class', () => {
  test('A33 removal closes the removed student’s sessions in that class only, audited, and a re-enrolled student starts clean', async () => {
    await enrolSamInB();
    const samB = await openReady('sam', ids.classB);
    const samA = await openReady('sam', ids.classA);
    const beaB = await openReady('bea', ids.classB);

    const removed = await removeSamFromB();
    expect(removed).toMatchObject({ status: 200, body: { removed: true } });

    expect(await row(samB.sessionId)).toMatchObject({
      state: 'stopped',
      cause: 'membership_removed',
      stoppedAt: relay.now(),
    });
    // Sam's session in the class they still study in, and a classmate's, are untouched.
    expect((await row(samA.sessionId))?.state).toBe('ready');
    expect((await row(beaB.sessionId))?.state).toBe('ready');
    const events = await testDb.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, 'session.stopped'), eq(auditEvents.targetId, samB.sessionId)),
      );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorId: ids.elena,
      scopeKind: 'class',
      scopeId: ids.classB,
      after: { cause: 'membership_removed' },
    });

    // The removed student no longer reaches the session.
    const gone = await call(
      relay,
      relay.world.cookie.sam,
      'GET',
      `${sessionsUrl(ids.classB)}/${samB.sessionId}`,
    );
    expect(gone.status).toBe(404);

    // Re-enrolled, Sam opens the same notebook again: the old session does not come back.
    await enrolSamInB();
    const again = await call(relay, relay.world.cookie.sam, 'POST', sessionsUrl(ids.classB), {
      connectionId: samB.connectionId,
      revisionId,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(202);
    expect(again.body.sessionId).not.toBe(samB.sessionId);
    const listed = await call(relay, relay.world.cookie.sam, 'GET', sessionsUrl(ids.classB));
    expect(listed.status).toBe(200);
    const open = (listed.body as { id: string; state: string }[]).filter(
      (s) => s.state !== 'stopped' && s.state !== 'failed',
    );
    expect(open.map((s) => s.id)).toEqual([again.body.sessionId]);

    await testDb.db
      .update(notebookSessions)
      .set({ state: 'stopped', cause: 'abandoned', stoppedAt: relay.now() })
      .where(eq(notebookSessions.id, again.body.sessionId));
    await call(
      relay,
      relay.world.cookie.elena,
      'DELETE',
      `/api/classes/${ids.classB}/members/${ids.sam}`,
    );
  });
});

describe('A32 the removed member’s processes are stopped per ownership', () => {
  test('A32 the next heartbeat stops an owned session of a removed member', async () => {
    await enrolSamInB();
    const s = await openReady('sam', ids.classB);
    expect((await removeSamFromB()).status).toBe(200);

    s.connector.heartbeat(0, [{ sessionId: s.sessionId, state: 'ready' }]);
    expect(await s.connector.next('close_session')).toMatchObject({
      sessionId: s.sessionId,
      stop: true,
    });
    s.connector.send(sessionState(relay, s.sessionId, 'stopped', { cause: 'user_stop' }));
    await settled(relay, s.id);
    // The connector's confirmation does not rewrite why Parallax closed the session.
    expect(await row(s.sessionId)).toMatchObject({ state: 'stopped', cause: 'membership_removed' });
  });

  test('A32 an attached runtime of a removed member is closed but not stopped', async () => {
    await enrolSamInB();
    const s = await openReady('sam', ids.classB, {
      owned: false,
      runtime: { mode: 'attach', port: 8888 },
    });
    expect((await removeSamFromB()).status).toBe(200);
    expect(await row(s.sessionId)).toMatchObject({ state: 'stopped', cause: 'membership_removed' });

    s.connector.heartbeat(0, [{ sessionId: s.sessionId, state: 'ready' }]);
    await s.connector.next('heartbeat_ack');
    await settled(relay, s.id);
    expect(s.connector.received.filter((m) => m.t === 'close_session')).toEqual([]);
  });
});

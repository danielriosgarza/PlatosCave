import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createSession } from '../../src/db/auth/sessions';
import { auditEvents, notebookConnections } from '../../src/db/schema';
import { TEST_TIMEOUT_MS } from '../../src/relay/tests';
import type { FakeConnector, Received } from '../fixtures/fake-connector';
import { cookieFor, ids, type PersonName } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';
import { type Relay, startRelay } from './relay';

/**
 * Test connection (docs/design/connector.md §2 step 3, §5.1, §5.2, §10.3) against the fake
 * connector over a real link: progress per stage, the `running` terminal-prompt report, the
 * 300 s deadline, and which host keys the server stores (A30, server half).
 */

const start = new Date('2026-10-01T09:00:00Z');
const fp = (c: string) => `SHA256:${c.repeat(43)}`;
const TARGET_KEY = fp('T');
const JUMP_KEY = fp('J');
const OLD_KEY = fp('O');
const NEW_KEY = fp('N');
const host = 'login.cluster.example.org';
const jumpHost = 'bastion.example.org';

let testDb: TestDatabase;
let relay: Relay;

beforeAll(async () => {
  testDb = await createTestDatabase();
  relay = await startRelay(testDb, start);
});

afterAll(async () => {
  await relay?.close();
  await testDb?.drop();
});

beforeEach(() => relay.advance(61_000));

/** A session signed in at the relay's current time (recent authentication holds). */
async function fresh(who: PersonName = 'sam') {
  const { token } = await createSession(testDb.db, ids[who], { now: relay.now() });
  return cookieFor(token);
}

async function call(cookie: string, method: 'GET' | 'POST', url: string, payload?: object) {
  const res = await relay.app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload && { payload }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: assertions walk the response freely.
  return { status: res.statusCode, body: res.json() as any };
}

interface Setup {
  connector: FakeConnector;
  connectionId: string;
  cookie: string;
}

/** A live connector of Sam's and one saved ssh connection on it. */
async function setup(options: { jump?: boolean; live?: boolean } = {}): Promise<Setup> {
  const { id, key } = await relay.connector();
  const cookie = await fresh();
  const created = await call(cookie, 'POST', '/api/me/connections', {
    name: `Cluster ${id.slice(0, 8)}`,
    connectorId: id,
    target: {
      kind: 'ssh',
      host,
      port: 22,
      user: 'sam',
      auth: { method: 'agent', hint: 'cluster' },
      workspace: '/home/sam/parallax',
      ...(options.jump && { jump: { host: jumpHost, port: 22, user: 'sam' } }),
    },
    runtime: { mode: 'start', kernelName: 'python3' },
  });
  expect(created.status).toBe(201);
  const connector = await relay.dial(id, key);
  if (options.live !== false) {
    await connector.link();
    await relay.until(() => relay.links.get(id) !== undefined, 'the link to go live');
  }
  return { connector, connectionId: created.body.id, cookie };
}

let seq = 0;
/** Moves time forward in heartbeat steps, so the link outlives the 45 s watchdog. */
async function keepAlive(connector: FakeConnector, ms: number) {
  for (let left = ms; left > 0; left -= 15_000) {
    relay.advance(Math.min(15_000, left));
    connector.heartbeat(++seq);
    await connector.next('heartbeat_ack');
  }
}

const startTest = (s: Setup, body: object = {}, cookie = s.cookie) =>
  call(cookie, 'POST', `/api/me/connections/${s.connectionId}/test`, body);
const poll = (s: Setup, testId: string, cookie = s.cookie) =>
  call(cookie, 'GET', `/api/me/connections/${s.connectionId}/tests/${testId}`);

async function trusted(connectionId: string) {
  const [row] = await testDb.db
    .select({ keys: notebookConnections.trustedHostKeys })
    .from(notebookConnections)
    .where(eq(notebookConnections.id, connectionId));
  return (row?.keys ?? []).map(({ host, port, sha256 }) => ({ host, port, sha256 }));
}

const ok = (name: string) => ({ name, status: 'ok', ms: 3 });
const identityOk = (...hops: [string, string][]) => ({
  name: 'host_identity',
  status: 'ok',
  data: { hops: hops.map(([hop, fingerprint]) => ({ hop, fingerprint })) },
});
const blocked = (name: string, by: string) => ({
  name,
  status: 'skipped',
  data: { reason: 'blocked', blockedBy: by },
});
const progress = (request: Received, stage: object) => ({
  v: 1,
  t: 'test_progress',
  requestId: request.requestId,
  stage,
});
const result = (request: Received, outcome: string, stages: object[]) => ({
  v: 1,
  t: 'test_result',
  requestId: request.requestId,
  outcome,
  stages,
});

/** Runs one test whose connector answers with `stages`; resolves with the request and poll. */
async function runTest(s: Setup, outcome: string, stages: object[], body: object = {}) {
  const started = await startTest(s, body);
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const request = await s.connector.next('test_connection');
  s.connector.send(result(request, outcome, stages));
  await relay.until(
    async () => (await poll(s, started.body.testId)).body.state === 'done',
    'the test to finish',
  );
  return { request, view: (await poll(s, started.body.testId)).body };
}

describe('progress and result', () => {
  test('stages appear as they finish, then the result', async () => {
    const s = await setup();
    const started = await startTest(s);
    expect(started.status).toBe(202);
    const request = await s.connector.next('test_connection');
    expect(request).toMatchObject({
      target: { kind: 'ssh', host, user: 'sam' },
      runtime: { mode: 'start', kernelName: 'python3' },
    });
    expect(request.target).not.toHaveProperty('hostKeys');
    s.connector.send(progress(request, ok('reachability')));
    await relay.until(
      async () => (await poll(s, started.body.testId)).body.stages.length === 1,
      'the first stage',
    );
    expect((await poll(s, started.body.testId)).body).toMatchObject({
      state: 'running',
      stages: [{ name: 'reachability', status: 'ok' }],
    });
    s.connector.send(
      result(request, 'ready_to_start', [
        ok('reachability'),
        identityOk(['target', TARGET_KEY]),
        ok('ssh_auth'),
        { name: 'workspace', status: 'ok', data: { resolvedPath: '/home/sam/parallax' } },
        ok('forwarding'),
        ok('runtime'),
        { name: 'notebook_auth', status: 'skipped', data: { reason: 'not_started' } },
        { name: 'kernels', status: 'ok', data: { source: 'cli' } },
      ]),
    );
    await relay.until(
      async () => (await poll(s, started.body.testId)).body.state === 'done',
      'the result',
    );
    const done = (await poll(s, started.body.testId)).body;
    expect(done).toMatchObject({ state: 'done', outcome: 'ready_to_start' });
    expect(done.stages).toHaveLength(8);
  });

  test('a running ssh_auth report is shown last in the poll until the stage finishes', async () => {
    const s = await setup();
    const started = await startTest(s);
    const request = await s.connector.next('test_connection');
    s.connector.send(progress(request, ok('reachability')));
    s.connector.send(progress(request, identityOk(['target', TARGET_KEY])));
    s.connector.send(
      progress(request, {
        name: 'ssh_auth',
        status: 'running',
        data: { hop: 'target', terminalPrompt: true },
      }),
    );
    await relay.until(
      async () => (await poll(s, started.body.testId)).body.stages.length === 3,
      'the running stage',
    );
    const waiting = (await poll(s, started.body.testId)).body;
    expect(waiting.state).toBe('running');
    expect(waiting.stages.at(-1)).toEqual({
      name: 'ssh_auth',
      status: 'running',
      data: { hop: 'target', terminalPrompt: true },
    });
    s.connector.send(progress(request, ok('ssh_auth')));
    await relay.until(
      async () => (await poll(s, started.body.testId)).body.stages.at(-1).status === 'ok',
      'the finished stage',
    );
    expect(
      (await poll(s, started.body.testId)).body.stages.map((st: { name: string }) => st.name),
    ).toEqual(['reachability', 'host_identity', 'ssh_auth']);
  });

  test('test_timeout after 300 s, not extended by a terminal prompt', async () => {
    const s = await setup();
    const started = await startTest(s);
    const request = await s.connector.next('test_connection');
    await keepAlive(s.connector, TEST_TIMEOUT_MS - 20_000);
    s.connector.send(
      progress(request, {
        name: 'ssh_auth',
        status: 'running',
        data: { hop: 'target', terminalPrompt: true },
      }),
    );
    await relay.until(
      async () => (await poll(s, started.body.testId)).body.stages.length === 1,
      'the running stage',
    );
    await keepAlive(s.connector, 19_999);
    expect((await poll(s, started.body.testId)).body.state).toBe('running');
    await keepAlive(s.connector, 1);
    expect((await poll(s, started.body.testId)).body).toEqual({
      testId: started.body.testId,
      state: 'done',
      stages: [],
      outcome: 'failed',
      code: 'test_timeout',
    });
    // A result after the deadline changes nothing.
    s.connector.send(result(request, 'ready_to_start', [ok('reachability')]));
    expect((await poll(s, started.body.testId)).body.code).toBe('test_timeout');
  });

  test('a test needs a live link, and a link lost mid-test ends it with connector_offline', async () => {
    const offline = await setup({ live: false });
    expect(await startTest(offline)).toMatchObject({
      status: 409,
      body: { error: 'connector_offline' },
    });
    const s = await setup();
    const started = await startTest(s);
    await s.connector.next('test_connection');
    s.connector.close();
    await relay.until(
      async () => (await poll(s, started.body.testId)).body.state === 'done',
      'the test to end',
    );
    expect((await poll(s, started.body.testId)).body).toMatchObject({
      outcome: 'failed',
      code: 'connector_offline',
    });
  });

  test("A33 another person's test is a 404, and a run is forgotten 10 minutes after it ends", async () => {
    const s = await setup();
    const { view } = await runTest(s, 'failed', [
      { name: 'reachability', status: 'failed', code: 'connection_timeout' },
    ]);
    const bea = await fresh('bea');
    expect((await poll(s, view.testId, bea)).status).toBe(404);
    relay.advance(10 * 60_000);
    expect((await poll(s, view.testId)).status).toBe(404);
  });
});

describe('host keys are persisted only from data.hops (§5.2)', () => {
  test("a direct target's confirmed first-use key is stored, with its audit event", async () => {
    const s = await setup();
    const first = await runTest(s, 'needs_action', [
      ok('reachability'),
      {
        name: 'host_identity',
        status: 'needs_action',
        code: 'host_key_unknown',
        data: { hop: 'target', fingerprint: TARGET_KEY },
      },
      blocked('ssh_auth', 'host_identity'),
    ]);
    expect(first.view.outcome).toBe('needs_action');
    expect(await trusted(s.connectionId)).toEqual([]);

    const confirmation = { host, port: 22, sha256: TARGET_KEY };
    const second = await runTest(
      s,
      'ready_to_start',
      [ok('reachability'), identityOk(['target', TARGET_KEY]), ok('ssh_auth')],
      { confirmations: [confirmation] },
    );
    expect(second.request.confirmations).toEqual([confirmation]);
    expect(await trusted(s.connectionId)).toEqual([{ host, port: 22, sha256: TARGET_KEY }]);
    const events = await testDb.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, 'connection.host_key_trusted'),
          eq(auditEvents.targetId, s.connectionId),
        ),
      );
    expect(events).toHaveLength(1);

    // The next test carries the trusted key in the target.
    const third = await runTest(s, 'ready_to_start', [identityOk(['target', TARGET_KEY])]);
    expect(third.request.target).toMatchObject({
      hostKeys: [{ host, port: 22, sha256: TARGET_KEY }],
    });
  });

  test('both hops of a jump route are stored', async () => {
    const s = await setup({ jump: true });
    await runTest(s, 'ready_to_start', [
      ok('reachability'),
      identityOk(['jump', JUMP_KEY], ['target', TARGET_KEY]),
    ]);
    expect(await trusted(s.connectionId)).toEqual([
      { host: jumpHost, port: 22, sha256: JUMP_KEY },
      { host, port: 22, sha256: TARGET_KEY },
    ]);
  });

  test('a jump host confirmed while the target still needs confirmation is stored', async () => {
    const s = await setup({ jump: true });
    await runTest(s, 'needs_action', [
      ok('reachability'),
      {
        name: 'host_identity',
        status: 'needs_action',
        code: 'host_key_unknown',
        data: {
          hop: 'target',
          fingerprint: TARGET_KEY,
          hops: [{ hop: 'jump', fingerprint: JUMP_KEY }],
        },
      },
    ]);
    expect(await trusted(s.connectionId)).toEqual([{ host: jumpHost, port: 22, sha256: JUMP_KEY }]);
  });

  test('a listed hop with no record is stored even without a confirmation (row 1)', async () => {
    const s = await setup();
    const started = await startTest(s);
    const request = await s.connector.next('test_connection');
    // Reported in progress: stored before the poll shows the stage.
    s.connector.send(progress(request, identityOk(['target', TARGET_KEY])));
    await relay.until(
      async () => (await poll(s, started.body.testId)).body.stages.length === 1,
      'the stage',
    );
    expect(await trusted(s.connectionId)).toEqual([{ host, port: 22, sha256: TARGET_KEY }]);
  });

  test('A30 a changed host key is never stored and a replace needs the stored fingerprint and recent authentication', async () => {
    const s = await setup();
    await runTest(s, 'ready_to_start', [identityOk(['target', OLD_KEY])]);
    expect(await trusted(s.connectionId)).toEqual([{ host, port: 22, sha256: OLD_KEY }]);

    const changed = await runTest(s, 'failed', [
      ok('reachability'),
      {
        name: 'host_identity',
        status: 'failed',
        code: 'host_key_changed',
        data: { hop: 'target', expected: OLD_KEY, presented: NEW_KEY },
      },
      blocked('ssh_auth', 'host_identity'),
    ]);
    expect(changed.view.outcome).toBe('failed');
    expect(await trusted(s.connectionId)).toEqual([{ host, port: 22, sha256: OLD_KEY }]);

    // A hop that passed with a key differing from the record, unconfirmed: the record is kept.
    await runTest(s, 'ready_to_start', [identityOk(['target', NEW_KEY])]);
    expect(await trusted(s.connectionId)).toEqual([{ host, port: 22, sha256: OLD_KEY }]);

    const replace = { host, port: 22, sha256: NEW_KEY, replacing: OLD_KEY };
    // A session signed in more than 15 minutes ago cannot replace.
    const stale = await fresh();
    await keepAlive(s.connector, 16 * 60_000);
    const refused = await startTest(s, { confirmations: [replace] }, stale);
    expect(refused).toMatchObject({ status: 401, body: { code: 'recent_auth_required' } });
    s.cookie = await fresh();
    // `replacing` must be the key the latest host_key_changed reported as expected.
    expect(
      await startTest(s, { confirmations: [{ ...replace, replacing: TARGET_KEY }] }),
    ).toMatchObject({ status: 409, body: { error: 'replacing_mismatch' } });
    const replaced = await runTest(s, 'ready_to_start', [identityOk(['target', NEW_KEY])], {
      confirmations: [replace],
    });
    expect(replaced.request.confirmations).toEqual([replace]);
    expect(await trusted(s.connectionId)).toEqual([{ host, port: 22, sha256: NEW_KEY }]);
    const [event] = await testDb.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, 'connection.host_key_replaced'),
          eq(auditEvents.targetId, s.connectionId),
        ),
      );
    expect(event?.before).toMatchObject({ sha256: OLD_KEY });
    expect(event?.after).toMatchObject({ sha256: NEW_KEY });
  });

  test("a replace may name the connector's record when the server holds none", async () => {
    const s = await setup();
    // Row 3: the connector's own record differs; the server has no record for this connection.
    await runTest(s, 'failed', [
      {
        name: 'host_identity',
        status: 'failed',
        code: 'host_key_changed',
        data: { hop: 'target', expected: OLD_KEY, presented: NEW_KEY },
      },
    ]);
    expect(await trusted(s.connectionId)).toEqual([]);
    await runTest(s, 'ready_to_start', [identityOk(['target', NEW_KEY])], {
      confirmations: [{ host, port: 22, sha256: NEW_KEY, replacing: OLD_KEY }],
    });
    expect(await trusted(s.connectionId)).toEqual([{ host, port: 22, sha256: NEW_KEY }]);
  });
});

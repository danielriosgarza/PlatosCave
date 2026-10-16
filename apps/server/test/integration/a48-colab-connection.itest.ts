import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { createSession } from '../../src/db/auth/sessions';
import { auditEvents, notebookConnections } from '../../src/db/schema';
import { cookieFor, ids } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';
import { call, insertNotebook, keepAlive, liveConnector, relink } from './notebook-sessions';
import { type Relay, startRelay } from './relay';

/**
 * Colab over SSH on the server (docs/design/connector.md §5.7, §4.6, §5.2): a saved `colab`
 * connection reaches only a connector whose live `hello` lists `colab`, what is sent names no
 * host, program or command, and the runtime's key is kept under the trust name `colab.invalid:22`.
 */

const start = new Date('2026-10-01T09:00:00Z');
const fp = (c: string) => `SHA256:${c.repeat(43)}`;
const OLD_KEY = fp('O');
const NEW_KEY = fp('N');
const TRUST = { host: 'colab.invalid', port: 22 };
const TARGET = {
  kind: 'colab',
  user: 'root',
  auth: { method: 'key', keyPath: '~/.ssh/colab' },
  workspace: '/content/parallax',
};
const OFFERS_COLAB = { targets: ['local', 'ssh', 'colab'] };

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

beforeEach(() => relay.advance(61_000));

/** A cookie of Sam's signed in now, so a replacement's recent sign-in holds. */
async function fresh() {
  const { token } = await createSession(testDb.db, ids.sam, { now: relay.now() });
  return cookieFor(token);
}

/** Sam's live connector, linked with `hello`, and a saved colab connection on it. */
async function colabConnection(hello: object = {}) {
  const live = await liveConnector(relay, ids.sam, hello);
  const cookie = await fresh();
  const saved = await call(relay, cookie, 'POST', '/api/me/connections', {
    name: `Colab ${live.id.slice(0, 8)}`,
    connectorId: live.id,
    target: TARGET,
    runtime: { mode: 'start', kernelName: 'python3' },
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(201);
  return { ...live, cookie, connectionId: saved.body.id as string };
}
type Colab = Awaited<ReturnType<typeof colabConnection>>;

/** Runs one test whose connector answers with `stages`; resolves with the request it got. */
async function runTest(c: Colab, outcome: string, stages: object[], body: object = {}) {
  const url = `/api/me/connections/${c.connectionId}`;
  const started = await call(relay, c.cookie, 'POST', `${url}/test`, body);
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const request = await c.connector.next('test_connection');
  c.connector.send({ v: 1, t: 'test_result', requestId: request.requestId, outcome, stages });
  await relay.until(
    async () =>
      (await call(relay, c.cookie, 'GET', `${url}/tests/${started.body.testId}`)).body.state ===
      'done',
    'the test to finish',
  );
  return request;
}

const listed = (fingerprint: string) => ({
  name: 'host_identity',
  status: 'ok',
  data: { hops: [{ hop: 'target', fingerprint }] },
});

async function trusted(connectionId: string) {
  const [row] = await testDb.db
    .select({ keys: notebookConnections.trustedHostKeys })
    .from(notebookConnections)
    .where(eq(notebookConnections.id, connectionId));
  return (row?.keys ?? []).map(({ host, port, sha256 }) => ({ host, port, sha256 }));
}

test('A48 a Colab connection is tested and opened only through a connector that offers Colab, and what is sent names no host, program or command', async () => {
  const c = await colabConnection();
  const sessions = `/api/classes/${ids.classA}/notebook-sessions`;
  const open = { connectionId: c.connectionId, revisionId };
  const unsupported = {
    status: 400,
    body: { error: 'target_not_allowed', code: 'unsupported_target' },
  };
  const testUrl = `/api/me/connections/${c.connectionId}/test`;
  expect(await call(relay, c.cookie, 'POST', testUrl, {})).toMatchObject(unsupported);
  expect(await call(relay, c.cookie, 'POST', sessions, open)).toMatchObject(unsupported);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const requests = (types: string[]) => c.connector.received.filter((m) => types.includes(m.t));
  expect(requests(['test_connection', 'open_session'])).toEqual([]);

  const connector = await relink(relay, c.id, c.key, OFFERS_COLAB);
  const confirmation = { ...TRUST, sha256: OLD_KEY };
  const request = await runTest({ ...c, connector }, 'ready_to_start', [listed(OLD_KEY)], {
    confirmations: [confirmation],
  });
  expect(request.target).toEqual(TARGET);
  expect(request.confirmations).toEqual([confirmation]);
  expect(await trusted(c.connectionId)).toEqual([confirmation]);

  const opened = await call(relay, c.cookie, 'POST', sessions, open);
  expect(opened.status, JSON.stringify(opened.body)).toBe(202);
  const session = await connector.next('open_session');
  // Exactly these fields: no host, port, jump host, program or command.
  expect(session.target).toEqual({ ...TARGET, hostKeys: [confirmation] });
});

test('a Colab runtime key is replaced only by a confirmation that names the Colab trust name, after a recent sign-in', async () => {
  const c = await colabConnection(OFFERS_COLAB);
  await runTest(c, 'ready_to_start', [listed(OLD_KEY)]);
  expect(await trusted(c.connectionId)).toEqual([{ ...TRUST, sha256: OLD_KEY }]);
  await runTest(c, 'failed', [
    {
      name: 'host_identity',
      status: 'failed',
      code: 'host_key_changed',
      data: { hop: 'target', expected: OLD_KEY, presented: NEW_KEY },
    },
  ]);
  expect(await trusted(c.connectionId)).toEqual([{ ...TRUST, sha256: OLD_KEY }]);

  const replace = { ...TRUST, sha256: NEW_KEY, replacing: OLD_KEY };
  const testUrl = `/api/me/connections/${c.connectionId}/test`;
  const stale = await fresh();
  await keepAlive(relay, c.connector, 16 * 60_000);
  expect(await call(relay, stale, 'POST', testUrl, { confirmations: [replace] })).toMatchObject({
    status: 401,
    body: { code: 'recent_auth_required' },
  });
  c.cookie = await fresh();
  const elsewhere = { host: 'runtime.colab.example.org', port: 22, sha256: NEW_KEY };
  expect(
    await call(relay, c.cookie, 'POST', testUrl, { confirmations: [elsewhere] }),
  ).toMatchObject({
    status: 400,
    body: { error: 'target_not_allowed', code: 'invalid_target', rules: [7] },
  });
  expect(await trusted(c.connectionId)).toEqual([{ ...TRUST, sha256: OLD_KEY }]);

  await runTest(c, 'ready_to_start', [listed(NEW_KEY)], { confirmations: [replace] });
  expect(await trusted(c.connectionId)).toEqual([{ ...TRUST, sha256: NEW_KEY }]);
  const events = await testDb.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.targetId, c.connectionId));
  const event = events.find((e) => e.action === 'connection.host_key_replaced');
  expect(event?.before).toMatchObject({ ...TRUST, sha256: OLD_KEY });
  expect(event?.after).toMatchObject({ ...TRUST, sha256: NEW_KEY });
});

import type { Db } from '../../src/db/client';
import { adoptRelease } from '../../src/db/content/adoption';
import { createResource } from '../../src/db/content/drafts';
import { publishRelease } from '../../src/db/content/releases';
import { sessionRelays } from '../../src/relay/sessions';
import type { ConnectorKey, FakeConnector } from '../fixtures/fake-connector';
import { asClassScope, asCourseScope, ids } from '../fixtures/world';
import type { Relay } from './relay';

/** Each database's notebook revision, so a test file publishes and adopts once. */
const revisions = new WeakMap<Db, Promise<string>>();

/**
 * Adds a notebook to *Statistical thinking*, publishes the next release and has classes A and B
 * adopt it; resolves with the notebook's revision id, which sessions open. Once per database.
 */
export function insertNotebook(db: Db, now: Date): Promise<string> {
  const known = revisions.get(db);
  if (known) return known;
  const made = (async () => {
    const course = asCourseScope(ids.statistics, ids.elena);
    const created = await createResource(
      db,
      course,
      ids.sampling,
      { type: 'notebook', title: 'Repeated samples', content: {} },
      now,
    );
    if (!created.ok) throw new Error(JSON.stringify(created));
    const revisionId = created.value.headRevisionId;
    if (!revisionId) throw new Error('the notebook has no head revision');
    const published = await publishRelease(db, course);
    if (!published.ok) throw new Error(JSON.stringify(published.report));
    for (const [classId, instructor] of [
      [ids.classA, ids.priya],
      [ids.classB, ids.marcus],
    ] as const) {
      const adopted = await adoptRelease(
        db,
        asClassScope(classId, ids.statistics, instructor, { releaseId: ids.releaseV1 }),
        { releaseId: published.release.id, expectedReleaseId: ids.releaseV1 },
      );
      if (!adopted.ok) throw new Error(adopted.reason);
    }
    return revisionId;
  })();
  revisions.set(db, made);
  return made;
}

// biome-ignore lint/suspicious/noExplicitAny: assertions walk the response freely.
export type Reply = { status: number; body: any };

/** A request through the relay app as the holder of `cookie`. */
export async function call(
  relay: Relay,
  cookie: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
): Promise<Reply> {
  const res = await relay.app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload && { payload }),
  });
  return { status: res.statusCode, body: res.json() };
}

/** A live fake connector of `owner` (Sam by default), linked with the default `hello`. */
export async function liveConnector(
  relay: Relay,
  owner: string = ids.sam,
  hello: Parameters<FakeConnector['link']>[0] = {},
) {
  const { id, key } = await relay.connector({ owner });
  const connector = await relay.dial(id, key);
  await connector.link(hello);
  await relay.until(() => relay.links.get(id) !== undefined, 'the link to go live');
  return { id, key, connector };
}

/** Dials again as an existing connector and says `hello`; the link is live on return. */
export async function relink(
  relay: Relay,
  id: string,
  key: ConnectorKey,
  hello: Parameters<FakeConnector['link']>[0] = {},
) {
  const connector = await relay.dial(id, key);
  await connector.link(hello);
  await relay.until(
    () => relay.links.get(id) !== undefined && relay.links.get(id)?.hello !== undefined,
    'the link to go live again',
  );
  return connector;
}

let saved = 0;
/** Saves an ssh connection on `connectorId` for the holder of `cookie`; resolves with its id. */
export async function saveConnection(
  relay: Relay,
  cookie: string,
  connectorId: string,
  extra: { target?: object; runtime?: object; templateId?: string } = {},
): Promise<string> {
  const res = await call(relay, cookie, 'POST', '/api/me/connections', {
    name: `Connection ${++saved}`,
    connectorId,
    target: {
      kind: 'ssh',
      host: 'login.cluster.example.org',
      port: 22,
      user: 'student',
      auth: { method: 'agent', hint: 'cluster' },
      workspace: '/home/student/parallax',
    },
    runtime: { mode: 'start', kernelName: 'python3' },
    ...extra,
  });
  if (res.status !== 201) throw new Error(`save connection: ${JSON.stringify(res.body)}`);
  return res.body.id;
}

/** The connector's `session_state` answer or notice for `sessionId`. */
export const sessionState = (
  relay: Relay,
  sessionId: string,
  state: string,
  extra: Record<string, unknown> = {},
) => ({
  v: 1,
  t: 'session_state',
  sessionId,
  state,
  owned: true,
  ts: Math.floor(relay.now().getTime() / 1000),
  ...extra,
});

/** Waits until every report already received from `connectorId` has been applied. */
export async function settled(relay: Relay, connectorId: string) {
  // Let the socket deliver what was sent before asking the relay to drain.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await sessionRelays.get(relay.links)?.settled(connectorId);
}

let beat = 0;
/** Moves time forward in heartbeat steps, so the link outlives the 45 s watchdog. */
export async function keepAlive(relay: Relay, connector: FakeConnector, ms: number) {
  for (let left = ms; left > 0; left -= 15_000) {
    relay.advance(Math.min(15_000, left));
    connector.heartbeat(++beat);
    await connector.next('heartbeat_ack');
  }
}

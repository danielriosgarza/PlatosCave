import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { DEV_RUNNER_RUNTIMES, loadConfig } from '../../src/config';
import { adoptRelease } from '../../src/db/content/adoption';
import { publishRelease } from '../../src/db/content/releases';
import { resourceRevisions, resources } from '../../src/db/schema';
import { FsStorage } from '../../src/storage/fs';
import { asClassScope, asCourseScope, buildWorld, ids, type PersonName } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

/**
 * A11 (§10.7): a Shiny resource is framed only from an origin the host approved, always with an
 * external route; an address on any other origin reaches no one.
 */

const now = new Date('2026-10-01T09:00:00Z');
const APPROVED = 'https://shiny.example.org';
const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  APP_HOST: '127.0.0.1',
  CONTENT_HOST: 'localhost',
  CONTENT_ORIGIN: 'http://localhost:3100',
  APP_ORIGIN: 'http://127.0.0.1:3100',
  SHINY_ORIGINS: APPROVED,
});
const course = `/api/courses/${ids.statistics}`;

let testDb: TestDatabase;
let app: FastifyInstance;
let cookie: Record<PersonName, string>;
let root: string;
const revisions: Record<string, string> = {};

const api = async (who: PersonName, method: 'GET' | 'POST', url: string, payload?: object) => {
  const res = await app.inject({
    method,
    url,
    headers: { host: '127.0.0.1:3100', cookie: cookie[who] },
    ...(payload && { payload }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: assertions walk the response freely.
  return { status: res.statusCode, body: res.json() as any };
};
const shinyOf = (who: PersonName, key: string, classId = ids.classA) =>
  api(who, 'GET', `/api/classes/${classId}/resources/${revisions[key]}/shiny`);

beforeAll(async () => {
  testDb = await createTestDatabase();
  const world = await buildWorld(testDb.db, now);
  cookie = world.cookie;
  root = await mkdtemp(join(tmpdir(), 'parallax-shiny-'));
  app = await buildApp(config, { db: testDb.db, now: () => now, storage: new FsStorage(root) });
  await app.ready();
  const addresses = {
    approved: `${APPROVED}/sampling-lab/?lang=en`,
    otherOrigin: 'https://evil.example.org/sampling-lab/',
    lookalike: `${APPROVED}.evil.example.org/`,
  };
  for (const [key, url] of Object.entries(addresses)) {
    const created = await api('elena', 'POST', `${course}/topics/${ids.sampling}/resources`, {
      type: 'shiny',
      title: `Sampling lab ${key}`,
      content: { url },
    });
    expect(created.status).toBe(200);
    revisions[key] = created.body.headRevisionId;
  }
  // The draft API refuses these addresses now; data written before that check can still hold them.
  for (const [key, url] of Object.entries({
    credentials: 'https://user:secret@shiny.example.org/',
    notAnAddress: 'not an address',
  })) {
    const id = randomUUID();
    const revisionId = randomUUID();
    const content = { url };
    await testDb.db.insert(resources).values({
      id,
      courseId: ids.statistics,
      topicId: ids.sampling,
      type: 'shiny',
      title: `Sampling lab ${key}`,
      position: 90,
      createdBy: ids.elena,
    });
    await testDb.db.insert(resourceRevisions).values({
      id: revisionId,
      resourceId: id,
      courseId: ids.statistics,
      type: 'shiny',
      content,
      contentHash: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
      createdBy: ids.elena,
    });
    await testDb.db
      .update(resources)
      .set({ headRevisionId: revisionId })
      .where(eq(resources.id, id));
    revisions[key] = revisionId;
  }
  const published = await publishRelease(testDb.db, asCourseScope(ids.statistics, ids.elena), {
    runtimes: DEV_RUNNER_RUNTIMES,
  });
  if (!published.ok) throw new Error(JSON.stringify(published.report));
  const adopted = await adoptRelease(
    testDb.db,
    asClassScope(ids.classA, ids.statistics, ids.priya),
    { releaseId: published.release.id, expectedReleaseId: ids.releaseV1 },
  );
  if (!adopted.ok) throw new Error(adopted.reason);
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('A11 Shiny embed', () => {
  test('A11 the tab lists Shiny resources with their type', async () => {
    const list = await api(
      'sam',
      'GET',
      `/api/classes/${ids.classA}/topics/${ids.sampling}/notebooks`,
    );
    expect(list.status).toBe(200);
    expect(
      list.body.notebooks.map((n: { title: string; type: string }) => [n.title, n.type]),
    ).toContainEqual(['Sampling lab approved', 'shiny']);
  });

  test('A11 an address on an approved origin is returned with the origin its messages must come from', async () => {
    const { status, body } = await shinyOf('sam', 'approved');
    expect(status).toBe(200);
    expect(body).toEqual({
      revisionId: revisions.approved,
      title: 'Sampling lab approved',
      status: 'ready',
      url: `${APPROVED}/sampling-lab/?lang=en`,
      origin: APPROVED,
    });
  });

  test('A11 an address on another origin, a look-alike host, embedded credentials or no address is neither framed nor linked', async () => {
    for (const key of ['otherOrigin', 'lookalike', 'credentials', 'notAnAddress']) {
      const { status, body } = await shinyOf('sam', key);
      expect(status).toBe(200);
      expect(body).toMatchObject({ status: 'unapproved', url: null, origin: null });
    }
  });

  test('A11 the app origin allows framing only the content origin and the approved Shiny origins', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '127.0.0.1:3100' },
    });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain(`frame-src http://localhost:3100 ${APPROVED}`);
    expect(csp).not.toContain('evil.example.org');
  });

  test('A11 a non-member and another class get 404, and a notebook is not a Shiny resource', async () => {
    expect((await shinyOf('olivia', 'approved')).status).toBe(404);
    expect((await shinyOf('bea', 'approved', ids.classB)).status).toBe(404);
    expect((await shinyOf('bea', 'approved')).status).toBe(404);
    expect(
      (await api('sam', 'GET', `/api/classes/${ids.classA}/resources/${ids.sampling}/shiny`))
        .status,
    ).toBe(404);
  });
});

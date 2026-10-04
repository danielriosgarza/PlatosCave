import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { PREVIEW_RETURN_COOKIE } from '../../src/auth/preview';
import { SESSION_COOKIE } from '../../src/auth/sessions';
import { loadConfig } from '../../src/config';
import { auditEvents } from '../../src/db/schema';
import { buildWorld, ids, type World } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

const now = new Date('2026-10-01T09:00:00Z');

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, now);
  app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' }), {
    db: testDb.db,
    now: () => now,
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

const rowsFor = (action: string) =>
  testDb.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, ids.previewB)));

describe('audit trail of draft previews', () => {
  test('preview start and exit each append an audit row for the instructor', async () => {
    const start = await app.inject({
      method: 'POST',
      url: `/api/courses/${ids.statistics}/preview`,
      headers: { cookie: world.cookie.marcus },
      payload: { classId: ids.classB, topicId: ids.sampling },
    });
    expect(start.statusCode).toBe(200);
    const browser = start.cookies
      .filter((c) => [SESSION_COOKIE, PREVIEW_RETURN_COOKIE].includes(c.name) && c.value)
      .map((c) => `${c.name}=${encodeURIComponent(c.value)}`)
      .join('; ');
    expect(await rowsFor('preview.start')).toEqual([
      expect.objectContaining({
        actorId: ids.marcus,
        scopeKind: 'class',
        scopeId: ids.classB,
        targetType: 'user',
        after: { topicId: ids.sampling },
      }),
    ]);
    expect(await rowsFor('preview.exit')).toHaveLength(0);

    const exit = await app.inject({
      method: 'POST',
      url: '/api/preview/exit',
      headers: { cookie: browser },
    });
    expect(exit.statusCode).toBe(200);
    expect(await rowsFor('preview.exit')).toEqual([
      expect.objectContaining({ actorId: ids.marcus, scopeKind: 'class', scopeId: ids.classB }),
    ]);
    // Exiting again with the ended preview's cookies appends nothing more.
    const again = await app.inject({
      method: 'POST',
      url: '/api/preview/exit',
      headers: { cookie: browser },
    });
    expect(again.statusCode).toBe(200);
    expect(await rowsFor('preview.exit')).toHaveLength(1);
  });
});

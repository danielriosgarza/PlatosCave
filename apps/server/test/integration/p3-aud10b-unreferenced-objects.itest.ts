import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { createSession } from '../../src/db/auth/sessions';
import { createUser } from '../../src/db/identity';
import { removeUnreferencedObjects, UNREFERENCED_OBJECT_MIN_AGE_MS } from '../../src/db/lifecycle';
import {
  connectors,
  fileTransfers,
  notebookConnections,
  notebookSessions,
  notebookSubmissionFiles,
  notebookSubmissions,
  notebookWorkingCopies,
  notebookWorkingCopyRevisions,
  storageObjects,
} from '../../src/db/schema';
import { FsStorage } from '../../src/storage/fs';
import {
  classSubmissionPrefix,
  classTransferPrefix,
  classWorkingCopyPrefix,
} from '../../src/storage/storage';
import { buildWorld, cookieFor, ids } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

/**
 * Stored objects of rows that account deletion removes do not outlive them (P3-AUD10b): the sweep
 * removes transfer and working-copy objects no row refers to, and keeps every object a submission
 * or another person's row still names. No acceptance scenario is assigned to this item.
 */

const start = new Date('2026-10-01T09:00:00Z');

let testDb: TestDatabase;
let app: FastifyInstance;
let root: string;
let storage: FsStorage;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await buildWorld(testDb.db, start);
  root = await mkdtemp(join(tmpdir(), 'parallax-sweep-'));
  storage = new FsStorage(root);
  app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), {
    db: testDb.db,
    storage,
    now: () => start,
    mode: 'relay',
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
  if (root) await rm(root, { recursive: true, force: true });
});

/** A person with an active connector, a connection and one stopped session in class A. */
async function withSession(email: string, name: string) {
  const userId = await createUser(testDb.db, { email, name });
  const [connector] = await testDb.db
    .insert(connectors)
    .values({
      ownerUserId: userId,
      name: 'Laptop',
      mode: 'personal',
      status: 'active',
      publicKey: Buffer.alloc(32, 7),
      fingerprint: `SHA256:${email}`,
      os: 'linux',
      arch: 'amd64',
      version: '0.1.0',
      approvedAt: start,
    })
    .returning({ id: connectors.id });
  const connectorId = connector?.id ?? '';
  const [connection] = await testDb.db
    .insert(notebookConnections)
    .values({ ownerUserId: userId, connectorId, name: 'Laptop', target: {}, runtime: {} })
    .returning({ id: notebookConnections.id });
  const [session] = await testDb.db
    .insert(notebookSessions)
    .values({
      classId: ids.classA,
      userId,
      connectionId: connection?.id ?? '',
      connectorId,
      resourceRevisionId: ids.samplingReadingV1,
      state: 'stopped',
      stoppedAt: start,
      owned: true,
      runtime: {},
      lease: { idleTimeoutMin: 30, gracePeriodMin: 5 },
    })
    .returning({ id: notebookSessions.id });
  return { userId, sessionId: session?.id ?? '' };
}

const exists = async (key: string) => (await storage.head(key)) !== null;

describe('removing the stored objects of deleted rows (P3-AUD10b)', () => {
  test('after an account is deleted its unsubmitted transfers and working copies leave storage; submitted and shared objects stay', async () => {
    const kai = await withSession('kai@example.test', 'Kai Tanaka');
    const lee = await withSession('lee@example.test', 'Lee Park');
    const transfers = classTransferPrefix(ids.classA);
    const copies = classWorkingCopyPrefix(ids.classA);

    // Transfers: one a submission froze, one nobody else has, one whose bytes Lee copied out too.
    const submittedFile = await storage.put(transfers, Buffer.from('kai results'));
    const scratchFile = await storage.put(transfers, Buffer.from('kai scratch'));
    const sharedFile = await storage.put(transfers, Buffer.from('the class dataset'));
    const transfer = async (userId: string, sessionId: string, path: string, key: string) => {
      const [row] = await testDb.db
        .insert(fileTransfers)
        .values({
          classId: ids.classA,
          sessionId,
          userId,
          direction: 'out',
          path,
          sha256: key.slice(-64),
          size: 10,
          state: 'done',
          objectKey: key,
        })
        .returning({ id: fileTransfers.id });
      return row?.id ?? '';
    };
    const submittedTransfer = await transfer(
      kai.userId,
      kai.sessionId,
      'results.csv',
      submittedFile.key,
    );
    await transfer(kai.userId, kai.sessionId, 'scratch.csv', scratchFile.key);
    await transfer(kai.userId, kai.sessionId, 'data.csv', sharedFile.key);
    await transfer(lee.userId, lee.sessionId, 'data.csv', sharedFile.key);

    // Working copies: one never submitted, and one whose revision 2 a submission froze.
    const revisionObjects = await Promise.all(
      ['loose 1', 'loose 2', 'frozen 1', 'frozen 2', 'frozen 3'].map((s) =>
        storage.put(copies, Buffer.from(s)),
      ),
    );
    const [loose1, loose2, frozen1, frozen2, frozen3] = revisionObjects.map((o) => o.key);
    const copy = async (sourceRevisionId: string, keys: (string | undefined)[]) => {
      const [row] = await testDb.db
        .insert(notebookWorkingCopies)
        .values({
          classId: ids.classA,
          userId: kai.userId,
          sourceRevisionId,
          currentRevision: keys.length,
        })
        .returning({ id: notebookWorkingCopies.id });
      const id = row?.id ?? '';
      await testDb.db.insert(notebookWorkingCopyRevisions).values(
        keys.map((key, i) => ({
          workingCopyId: id,
          revision: i + 1,
          classId: ids.classA,
          objectKey: key ?? '',
          sha256: (key ?? '').slice(-64),
          size: 7,
          source: 'server' as const,
        })),
      );
      return id;
    };
    await copy(ids.samplingReadingV1, [loose1, loose2]);
    const frozenCopy = await copy(ids.answerKeyV1, [frozen1, frozen2, frozen3]);

    const snapshot = await storage.put(
      classSubmissionPrefix(ids.classA),
      Buffer.from('kai notebook'),
    );
    const [submission] = await testDb.db
      .insert(notebookSubmissions)
      .values({
        classId: ids.classA,
        userId: kai.userId,
        resourceId: ids.answerKey,
        resourceRevisionId: ids.answerKeyV1,
        version: 1,
        submissionKey: 'kai-1',
        objectKey: snapshot.key,
        sha256: snapshot.sha256,
        size: snapshot.size,
        filename: 'work.ipynb',
        workingCopyId: frozenCopy,
        workingCopyRevision: 2,
        sessionId: kai.sessionId,
      })
      .returning({ id: notebookSubmissions.id });
    // The frozen file shares the object of its transfer, as the submit route records it.
    await testDb.db.insert(notebookSubmissionFiles).values({
      submissionId: submission?.id ?? '',
      path: 'results.csv',
      classId: ids.classA,
      fileTransferId: submittedTransfer,
      sha256: submittedFile.sha256,
      size: submittedFile.size,
      objectKey: submittedFile.key,
    });

    const { token } = await createSession(testDb.db, kai.userId, { now: start });
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/delete',
      headers: { cookie: cookieFor(token) },
      payload: { confirm: true },
    });
    expect(res.statusCode).toBe(200);

    const gone = [scratchFile.key, loose1, loose2, frozen1, frozen3] as string[];
    const kept = [submittedFile.key, sharedFile.key, frozen2, snapshot.key] as string[];
    // Deleting the rows leaves the objects in place until the sweep runs.
    for (const key of [...gone, ...kept]) expect(await exists(key), key).toBe(true);

    // Objects written moments ago are not candidates yet: their rows may still be on the way.
    expect(await removeUnreferencedObjects(testDb.db, storage, new Date())).toEqual({
      objectsRemoved: 0,
    });
    for (const key of gone) expect(await exists(key), key).toBe(true);

    const later = new Date(Date.now() + UNREFERENCED_OBJECT_MIN_AGE_MS + 60_000);
    expect(await removeUnreferencedObjects(testDb.db, storage, later)).toEqual({
      objectsRemoved: gone.length,
    });
    for (const key of gone) expect(await exists(key), key).toBe(false);
    for (const key of kept) expect(await exists(key), key).toBe(true);
    // What remains is still readable through the rows that name it.
    expect((await storage.get(frozen2 ?? '')).size).toBe(Buffer.from('frozen 2').length);

    // A second run finds nothing more to remove.
    expect(await removeUnreferencedObjects(testDb.db, storage, later)).toEqual({
      objectsRemoved: 0,
    });
  });

  test('an object any reference column names stays; one nothing names goes', async () => {
    // Content addressing lets a key appear in any column, so the course's own record is asked too.
    const transfers = classTransferPrefix(ids.classA);
    const recorded = await storage.put(transfers, Buffer.from('recorded by the course'));
    await testDb.db.insert(storageObjects).values({
      courseId: ids.statistics,
      key: recorded.key,
      sha256: recorded.sha256,
      size: recorded.size,
      contentType: 'text/csv',
    });
    const orphan = await storage.put(transfers, Buffer.from('nobody refers to this'));
    const later = new Date(Date.now() + UNREFERENCED_OBJECT_MIN_AGE_MS + 60_000);
    expect(await removeUnreferencedObjects(testDb.db, storage, later)).toEqual({
      objectsRemoved: 1,
    });
    expect(await exists(orphan.key)).toBe(false);
    expect(await exists(recorded.key)).toBe(true);
  });
});

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { auditEvents, users } from '../../src/db/schema';
import { ids } from '../fixtures/world';
import { attemptUrl, call, type ExecWorld, execWorld, startAttempt } from './execution';

/**
 * A21 (export part): the CSV of results holds only the selected class's own students and
 * attempts, only that class's instructors can ask for it, its download works only from the
 * content origin, and user-controlled text cannot run as a spreadsheet formula (§12).
 */

let w: ExecWorld;
const exportUrl = (classId: string) => `/api/classes/${classId}/exports/results`;
const attempt: Record<string, string> = {};

/** The file behind a download URL, fetched as a browser would from the content origin. */
async function download(url: string) {
  const { pathname, host } = new URL(url);
  const res = await w.app.inject({ method: 'GET', url: pathname, headers: { host } });
  return { res, text: res.body };
}

/** Rows as arrays; the fixtures hold no commas or line breaks except where a test says so. */
const parse = (csv: string) =>
  csv
    .trimEnd()
    .split('\r\n')
    .map((line) => line.split(','));

beforeAll(async () => {
  w = await execWorld();
  w.clock.now = new Date(w.clock.now.getTime() + 60_000);
  // A student's name is user-controlled text.
  await w.testDb.db.update(users).set({ name: '=1+1' }).where(eq(users.id, ids.bea));
  attempt.bea = await startAttempt(w, 'bea', ids.classB);
  attempt.sam = await startAttempt(w, 'sam', ids.classB);
  attempt.samA = await startAttempt(w, 'sam', ids.classA);
  const submitted = await call(
    w,
    'sam',
    'POST',
    `${attemptUrl(ids.classB, attempt.sam as string)}/submit`,
    {
      submissionKey: 'export-sam',
    },
  );
  expect(submitted.status).toBe(200);
  const draft = await call(
    w,
    'marcus',
    'POST',
    `${attemptUrl(ids.classB, attempt.sam as string)}/grade`,
    {
      expectedGradeId: null,
      manual: [],
      feedback: [],
    },
  );
  expect(draft.status).toBe(200);
});
afterAll(async () => {
  await w?.close();
});

describe('A21 results export', () => {
  test('A21 an instructor’s export holds the selected class’s own attempts and no other cohort’s', async () => {
    const made = await call(w, 'marcus', 'POST', exportUrl(ids.classB));
    expect(made.status).toBe(201);
    expect(made.body.rows).toBe(2);
    expect(made.body.filename).toMatch(/\.csv$/);
    const file = await download(made.body.url);
    expect(file.res.statusCode).toBe(200);
    expect(file.res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(file.res.headers['content-disposition']).toContain('attachment');

    const [header, ...rows] = parse(file.text);
    expect(header).toEqual([
      'course',
      'class',
      'assignment',
      'student',
      'attempt',
      'attempt_state',
      'grade_state',
      'points',
      'possible',
      'started_at',
      'submitted_at',
      'graded_at',
      'released_at',
    ]);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.slice(0, 3)).toEqual(['Statistical thinking', 'Autumn 2026 B', 'Spread check']);
    }
    // Sam's attempt in class A is not in class B's file.
    expect(rows.map((r) => r[3]).sort()).toEqual(["'=1+1", 'Sam Okafor']);
    expect(file.text).not.toContain('Autumn 2026 A');
    const sam = rows.find((r) => r[3] === 'Sam Okafor');
    expect(sam?.slice(4, 7)).toEqual(['1', 'grading', 'draft']);
    expect(sam?.[10]).not.toBe('');
    const bea = rows.find((r) => r[3] === "'=1+1");
    expect(bea?.slice(4, 7)).toEqual(['1', 'in_progress', 'none']);
    expect(bea?.slice(7, 9)).toEqual(['', '']);
  });

  test('A21 each class exports its own file, and the audit trail names who exported which class', async () => {
    const made = await call(w, 'priya', 'POST', exportUrl(ids.classA));
    expect(made.status).toBe(201);
    expect(made.body.rows).toBe(1);
    const file = await download(made.body.url);
    expect(file.text).toContain('Autumn 2026 A');
    expect(file.text).not.toContain('Autumn 2026 B');

    const events = await w.testDb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'export.results'));
    expect(events.map((e) => [e.actorId, e.scopeKind, e.scopeId]).sort()).toEqual(
      [
        [ids.marcus, 'class', ids.classB],
        [ids.priya, 'class', ids.classA],
      ].sort(),
    );
    expect(events[0]?.after).toMatchObject({
      rows: expect.any(Number),
      sha256: expect.any(String),
    });
  });

  test('A21 outsiders get 404 and a member who is not an instructor gets 403, not the file', async () => {
    // Marcus and Noor are not members of the other class; Priya and Bea are students of B.
    for (const [who, classId, status] of [
      ['marcus', ids.classA, 404],
      ['noor', ids.classB, 404],
      ['priya', ids.classB, 403],
      ['bea', ids.classB, 403],
    ] as const) {
      const res = await call(w, who, 'POST', exportUrl(classId));
      expect(res.status, `${who} → ${classId}`).toBe(status);
    }
  });

  test('A21 the download link works only on the content origin and expires', async () => {
    const made = await call(w, 'marcus', 'POST', exportUrl(ids.classB));
    const { pathname } = new URL(made.body.url);
    const onApp = await w.app.inject({
      method: 'GET',
      url: pathname,
      headers: { host: '127.0.0.1:3100' },
    });
    expect(onApp.statusCode).toBe(404);
    const [, token] = pathname.split('/content/');
    const forged = await w.app.inject({
      method: 'GET',
      url: `/content/${token?.slice(0, -2)}xx`,
      headers: { host: 'localhost:3100' },
    });
    expect(forged.statusCode).toBe(404);
    w.clock.now = new Date(w.clock.now.getTime() + 10 * 60_000);
    const late = await w.app.inject({
      method: 'GET',
      url: pathname,
      headers: { host: 'localhost:3100' },
    });
    expect(late.statusCode).toBe(404);
  });
});

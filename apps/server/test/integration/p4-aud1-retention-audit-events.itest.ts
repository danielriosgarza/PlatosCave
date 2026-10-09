import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { applyRetention, type RetentionResult } from '../../src/db/lifecycle';
import { auditEvents } from '../../src/db/schema';
import { ids } from '../fixtures/world';
import { attemptUrl, call, type ExecWorld, execWorld, startAttempt } from './execution';

/**
 * P4-AUD1: audit retention (§13) keeps the audit events the product reads as state. A removed
 * student is recognised by their latest `membership.remove` event, and an attempt's recovery
 * state is its latest `test_attempt.recovery_requested` event; once `RETENTION_AUDIT_DAYS` has
 * passed them, the removed student's work must still be in review, grading and the results
 * export (§3, §12), and the recovery request still shown (§11). Class B: Marcus teaches Bea.
 */

const day = 86_400_000;
let w: ExecWorld;
let beaAttempt: string;
let requestedAt: string;
let swept: RetentionResult;
const supersededIds: string[] = [];
let unrelatedId: string;

const events = (action: string, targetId: string) =>
  w.testDb.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, targetId)));

beforeAll(async () => {
  w = await execWorld();
  const tick = () => {
    w.clock.now = new Date(w.clock.now.getTime() + 60_000);
  };
  tick();
  beaAttempt = await startAttempt(w, 'bea', ids.classB);
  tick();
  const submitted = await call(w, 'bea', 'POST', `${attemptUrl(ids.classB, beaAttempt)}/submit`, {
    submissionKey: 'retention-bea',
  });
  expect(submitted.status).toBe(200);
  const url = `${attemptUrl(ids.classB, beaAttempt)}/recovery-request`;
  tick();
  expect((await call(w, 'marcus', 'POST', url, { reason: 'First ask' })).status).toBe(201);
  tick();
  const asked = await call(w, 'marcus', 'POST', url, { reason: 'Second ask' });
  expect(asked.status).toBe(201);
  requestedAt = asked.body.requestedAt;

  // Bea had been removed from class B once before, as an instructor would see in the history;
  // she is removed again now. Only the latest removal says what she was.
  const [older] = await w.testDb.db
    .insert(auditEvents)
    .values({
      actorId: ids.marcus,
      action: 'membership.remove',
      scopeKind: 'class',
      scopeId: ids.classB,
      targetType: 'user',
      targetId: ids.bea,
      before: { role: 'student' },
      createdAt: new Date(w.clock.now.getTime() - 200 * day),
    })
    .returning({ id: auditEvents.id });
  const removed = await w.app.inject({
    method: 'DELETE',
    url: `/api/classes/${ids.classB}/members/${ids.bea}`,
    headers: { host: '127.0.0.1:3100', cookie: w.world.cookie.elena },
  });
  expect(removed.statusCode).toBe(200);
  // An event the product never reads, which the sweep must still delete.
  const [unrelated] = await w.testDb.db
    .insert(auditEvents)
    .values({
      actorId: ids.marcus,
      action: 'results.export',
      scopeKind: 'class',
      scopeId: ids.classB,
      targetType: 'class',
      targetId: ids.classB,
      createdAt: new Date(w.clock.now.getTime() - 200 * day),
    })
    .returning({ id: auditEvents.id });
  if (!older || !unrelated) throw new Error('fixture events were not inserted');
  supersededIds.push(older.id);
  const [firstAsk] = (await events('test_attempt.recovery_requested', beaAttempt)).filter(
    (e) => e.after && (e.after as { reason?: string }).reason === 'First ask',
  );
  if (!firstAsk) throw new Error('the first recovery request was not audited');
  supersededIds.push(firstAsk.id);
  unrelatedId = unrelated.id;

  // Every event above, removal included, is past a one-day audit period by now.
  const now = new Date(Date.now() + 30 * day);
  swept = await applyRetention(w.testDb.db, { deactivatedGraceDays: null, auditEventDays: 1 }, now);
});
afterAll(async () => {
  await w?.close();
});

describe('P4-AUD1 audit retention keeps the events read as state', () => {
  test('A25 the sweep keeps the latest removal and recovery request and deletes the rest', async () => {
    expect(swept.auditEventsDeleted).toBeGreaterThan(0);
    const left = await w.testDb.db.select({ id: auditEvents.id }).from(auditEvents);
    const leftIds = left.map((e) => e.id);
    for (const id of [...supersededIds, unrelatedId]) expect(leftIds).not.toContain(id);
    expect(await events('membership.remove', ids.bea)).toHaveLength(1);
    expect(await events('test_attempt.recovery_requested', beaAttempt)).toHaveLength(1);
  });

  test('A25 after retention a removed student’s attempt stays open in Class review and can be graded', async () => {
    const review = await call(
      w,
      'marcus',
      'GET',
      `/api/classes/${ids.classB}/review?assignmentId=${w.quizId}&attemptId=${beaAttempt}`,
    );
    expect(review.status).toBe(200);
    expect(review.body.selected).toMatchObject({ studentId: ids.bea, attemptId: beaAttempt });

    const grades = await call(
      w,
      'marcus',
      'GET',
      `/api/classes/${ids.classB}/resources/${w.quizId}/grades`,
    );
    const bea = grades.body.students.find(
      (s: { student: { id: string } }) => s.student.id === ids.bea,
    );
    expect(bea).toMatchObject({ removed: true, attempts: [{ attemptId: beaAttempt }] });
    const graded = await call(w, 'marcus', 'POST', `${attemptUrl(ids.classB, beaAttempt)}/grade`, {
      expectedGradeId: null,
      manual: [],
      feedback: [],
    });
    expect(graded.status).toBe(200);
  });

  test('A15 after retention the recovery request is still shown on the removed student’s attempt', async () => {
    const opened = await call(w, 'marcus', 'GET', `${attemptUrl(ids.classB, beaAttempt)}/review`);
    expect(opened.status).toBe(200);
    expect(opened.body.recoveryRequestedAt).toBe(requestedAt);
    const listed = await call(
      w,
      'marcus',
      'GET',
      `/api/classes/${ids.classB}/resources/${w.quizId}/test-attempts`,
    );
    expect(listed.body.attempts.find((a: { id: string }) => a.id === beaAttempt)).toMatchObject({
      removed: true,
      recoveryRequestedAt: requestedAt,
    });
  });

  test('A21 after retention the results export still holds the removed student’s attempt', async () => {
    const made = await call(w, 'marcus', 'POST', `/api/classes/${ids.classB}/exports/results`);
    expect(made.status).toBe(201);
    expect(made.body.rows).toBe(1);
    const { pathname, host } = new URL(made.body.url);
    const file = await w.app.inject({ method: 'GET', url: pathname, headers: { host } });
    expect(file.body).toContain('Bea Lindqvist');
  });
});

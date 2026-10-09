import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { assignmentOverrides } from '../../src/db/schema';
import { ids } from '../fixtures/world';
import { call, type ExecWorld, execWorld } from './execution';

/**
 * P4-AUD10: a grant names the instructor who made it (only while they are in the class), and the
 * grant form's roster comes from its own route. Class B: Marcus teaches Bea, Priya and Sam.
 */

let w: ExecWorld;
const base = () => `/api/classes/${ids.classB}/resources/${w.quizId}`;

beforeAll(async () => {
  w = await execWorld();
});

afterAll(async () => {
  await w?.close();
});

test('P4-AUD10 a grant carries the granting instructor, who is named only while in the class', async () => {
  const granted = await call(w, 'marcus', 'POST', `${base()}/overrides`, {
    studentId: ids.bea,
    extraAttempts: 1,
    extraMinutes: 0,
    closesAt: null,
    reason: 'Medical note',
  });
  expect(granted.status).toBe(201);
  expect(granted.body).toMatchObject({ grantedBy: ids.marcus, grantedByName: 'Marcus Webb' });

  const read = await call(w, 'marcus', 'GET', `${base()}/assignment`);
  expect(read.body.overrides).toHaveLength(1);
  expect(read.body.overrides[0]).toMatchObject({
    reason: 'Medical note',
    grantedBy: ids.marcus,
    grantedByName: 'Marcus Webb',
  });

  // Noor teaches class A only, so for class B she counts as someone who has left.
  // Grants are append-only; the latest one per student is in force.
  const [first] = await w.testDb.db
    .select()
    .from(assignmentOverrides)
    .where(eq(assignmentOverrides.id, granted.body.id));
  if (!first) throw new Error('grant not stored');
  await w.testDb.db.insert(assignmentOverrides).values({
    classId: first.classId,
    assignmentId: first.assignmentId,
    userId: ids.bea,
    extraAttempts: 2,
    reason: 'Second grant',
    grantedBy: ids.noor,
    createdAt: new Date(first.createdAt.getTime() + 60_000),
  });
  const left = await call(w, 'marcus', 'GET', `${base()}/assignment`);
  expect(left.body.overrides[0]).toMatchObject({
    reason: 'Second grant',
    grantedBy: ids.noor,
    grantedByName: null,
  });
});

test('P4-AUD10 the student list is the class’s students only, and instructors of the class alone read it', async () => {
  const res = await call(w, 'marcus', 'GET', `${base()}/assignment/students`);
  expect(res.status).toBe(200);
  expect(res.body.students.map((s: { id: string }) => s.id).sort()).toEqual(
    [ids.bea, ids.priya, ids.sam].sort(),
  );
  expect(JSON.stringify(res.body)).not.toContain('marcus');
  expect((await call(w, 'bea', 'GET', `${base()}/assignment/students`)).status).toBe(403);
  expect((await call(w, 'noor', 'GET', `${base()}/assignment/students`)).status).toBe(404);
});

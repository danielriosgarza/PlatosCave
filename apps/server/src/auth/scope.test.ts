import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { expect, expectTypeOf, test } from 'vitest';
import type { forCourse } from '../db/scoped';
import {
  assertRecentAuth,
  type ClassManagerScope,
  type ClassScope,
  type CourseContext,
  type CourseScope,
  type DraftPreviewScope,
  RECENT_AUTH_MS,
} from './scope';
import { readSessionToken, sessionCookieHeader } from './sessions';

test('recent authentication is required within 15 minutes', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  expect(() => assertRecentAuth(new Date(now.getTime() - RECENT_AUTH_MS), now)).not.toThrow();
  expect(() => assertRecentAuth(new Date(now.getTime() - RECENT_AUTH_MS - 1), now)).toThrow(
    expect.objectContaining({ statusCode: 401, code: 'recent_auth_required' }),
  );
});

test('the session token is read from the signed pc_session cookie only', async () => {
  const secret = 'a'.repeat(32);
  const app = Fastify();
  await app.register(cookie, { secret });
  app.get('/t', async (req) => ({ token: readSessionToken(req) ?? null }));
  const tokenFor = async (header?: string) =>
    (await app.inject({ url: '/t', headers: header ? { cookie: header } : {} })).json().token;

  expect(await tokenFor(`a=1; ${sessionCookieHeader('tok', secret)}; b=2`)).toBe('tok');
  // Unsigned, tampered, signed with another secret, wrong name, empty or missing: no token.
  expect(await tokenFor('pc_session=tok')).toBeNull();
  expect(await tokenFor(sessionCookieHeader('tok', secret).replace('tok', 'other'))).toBeNull();
  expect(await tokenFor(sessionCookieHeader('tok', 'b'.repeat(32)))).toBeNull();
  expect(await tokenFor(`x${sessionCookieHeader('tok', secret)}`)).toBeNull();
  expect(await tokenFor('pc_session=')).toBeNull();
  expect(await tokenFor()).toBeNull();
  await app.close();
});

// These assertions are checked by `pnpm typecheck` only: at run time `expectTypeOf` does nothing,
// so this test passes under `pnpm test` whatever the types say. The membership integration tests
// carry A01 behaviourally.
test('only course and class-manager scopes reach course rows, not a member’s class scope', () => {
  expectTypeOf<CourseScope>().toExtend<CourseContext>();
  expectTypeOf<ClassManagerScope>().toExtend<CourseContext>();
  expectTypeOf<ClassScope>().not.toExtend<CourseContext>();
  // A class scope reads the course draft only once narrowed to a draft preview (ADR-0003), and
  // a draft preview reads only the draft syllabus (`forDraftCourse`), never any course row.
  expectTypeOf<ClassScope>().not.toExtend<DraftPreviewScope>();
  expectTypeOf<DraftPreviewScope>().not.toExtend<CourseContext>();
  expectTypeOf<DraftPreviewScope>().not.toExtend<Parameters<typeof forCourse>[0]>();
});

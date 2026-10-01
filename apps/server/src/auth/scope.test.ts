import { expect, test } from 'vitest';
import { assertRecentAuth, RECENT_AUTH_MS } from './scope';
import { sessionTokenFrom } from './sessions';

test('recent authentication is required within 15 minutes', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  expect(() => assertRecentAuth(new Date(now.getTime() - RECENT_AUTH_MS), now)).not.toThrow();
  expect(() => assertRecentAuth(new Date(now.getTime() - RECENT_AUTH_MS - 1), now)).toThrow(
    expect.objectContaining({ statusCode: 401, code: 'recent_auth_required' }),
  );
});

test('the session token is read from the pc_session cookie only', () => {
  expect(sessionTokenFrom('a=1; pc_session=tok; b=2')).toBe('tok');
  expect(sessionTokenFrom('xpc_session=tok')).toBeUndefined();
  expect(sessionTokenFrom('pc_session=')).toBeUndefined();
  expect(sessionTokenFrom(undefined)).toBeUndefined();
});

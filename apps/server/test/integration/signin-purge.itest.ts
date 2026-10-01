import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { EmailLinkProvider, LINK_TTL_MS, LINKS_PER_EMAIL } from '../../src/auth/email-provider';
import { signinTokens } from '../../src/db/schema';
import { createBoss } from '../../src/jobs/boss';
import {
  PURGE_SIGNIN_TOKENS,
  purgeSigninTokens,
  SIGNIN_TOKEN_RETENTION_MS,
} from '../../src/jobs/maintenance';
import { createTestDatabase, type TestDatabase } from './db';

const now = new Date('2026-10-01T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(async () => {
  await testDb?.drop();
});

const row = (email: string, token: string, expiresAt: Date, usedAt?: Date) => ({
  email,
  tokenHash: token,
  createdAt: new Date(expiresAt.getTime() - LINK_TTL_MS),
  expiresAt,
  usedAt,
});

describe('sign-in link purge', () => {
  test('removes links expired over a day ago, used or not, and keeps the rest', async () => {
    const day = SIGNIN_TOKEN_RETENTION_MS;
    await testDb.db
      .insert(signinTokens)
      .values([
        row('p@example.org', 'old-unused', ago(day + 60_000)),
        row('p@example.org', 'old-used', ago(day + 60_000), ago(day + 3_600_000)),
        row('p@example.org', 'just-expired', ago(day - 60_000)),
        row('p@example.org', 'live', new Date(now.getTime() + 60_000)),
      ]);
    expect(await purgeSigninTokens(testDb.db, now)).toBe(2);
    const left = await testDb.db.select({ h: signinTokens.tokenHash }).from(signinTokens);
    expect(left.map((r) => r.h).sort()).toEqual(['just-expired', 'live']);
  });

  test('the per-address cap still counts live links after a purge', async () => {
    const sent: string[] = [];
    const provider = new EmailLinkProvider({
      db: testDb.db,
      mailer: { send: async (m) => void sent.push(m.to) },
      now: () => now,
      appOrigin: 'http://app.parallax.test',
      log: { info() {}, error() {} } as never,
    });
    const email = 'cap@example.org';
    await testDb.db
      .insert(signinTokens)
      .values(row(email, 'cap-old', ago(2 * SIGNIN_TOKEN_RETENTION_MS)));
    await purgeSigninTokens(testDb.db, now);
    for (let i = 0; i < LINKS_PER_EMAIL + 2; i++) {
      await provider.begin({ email, destination: '/courses' });
    }
    expect(sent).toHaveLength(LINKS_PER_EMAIL);
    const [n] = await testDb.db
      .select({ n: count() })
      .from(signinTokens)
      .where(eq(signinTokens.email, email));
    expect(n?.n).toBe(LINKS_PER_EMAIL);
    // A purge leaves those live links, so the cap holds afterwards too.
    expect(await purgeSigninTokens(testDb.db, now)).toBe(0);
    await provider.begin({ email, destination: '/courses' });
    expect(sent).toHaveLength(LINKS_PER_EMAIL);
  });

  test('the worker schedules the purge on pg-boss', async () => {
    const boss = createBoss(testDb.db.$client, { role: 'worker', onError: () => {} });
    await boss.start();
    try {
      const { workMaintenance } = await import('../../src/jobs/maintenance');
      await workMaintenance(boss, testDb.db, { warn() {}, info() {} });
      const schedules = await boss.getSchedules();
      expect(schedules.map((s) => s.name)).toContain(PURGE_SIGNIN_TOKENS);
    } finally {
      await boss.stop({ graceful: false });
    }
  });
});

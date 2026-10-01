import { count, eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  EmailLinkProvider,
  LINK_TTL_MS,
  LINKS_PER_EMAIL,
  purgeSigninTokens,
  SIGNIN_TOKEN_RETENTION_MS,
} from '../../src/auth/email-provider';
import { createBoss } from '../../src/db/jobs/boss';
import { signinTokens } from '../../src/db/schema';
import { PURGE_SIGNIN_TOKENS, workMaintenance } from '../../src/jobs/maintenance';
import { createTestDatabase, type TestDatabase } from './db';

// Real clock: the queue test's handler purges against `new Date()`, so every fixture is relative to it.
const now = new Date();
const ago = (ms: number) => new Date(now.getTime() - ms);
let testDb: TestDatabase;
let boss: PgBoss;

beforeAll(async () => {
  testDb = await createTestDatabase();
  boss = createBoss(testDb.db.$client, { role: 'worker', onError: () => {}, onWarning: () => {} });
  await boss.start();
});
afterAll(async () => {
  await boss?.stop({ graceful: false });
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
        row('p@example.org', 'just-expired', ago(day - 3_600_000)),
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
    // The address's live links fill the cap; one old link is purgeable.
    for (let i = 0; i < LINKS_PER_EMAIL; i++) {
      await provider.begin({ email, destination: '/courses' });
    }
    expect(sent).toHaveLength(LINKS_PER_EMAIL);
    await testDb.db
      .insert(signinTokens)
      .values(row(email, 'cap-old', ago(2 * SIGNIN_TOKEN_RETENTION_MS)));
    expect(await purgeSigninTokens(testDb.db, now)).toBe(1);
    await provider.begin({ email, destination: '/courses' });
    expect(sent).toHaveLength(LINKS_PER_EMAIL);
    const [n] = await testDb.db
      .select({ n: count() })
      .from(signinTokens)
      .where(eq(signinTokens.email, email));
    expect(n?.n).toBe(LINKS_PER_EMAIL);
  });

  test('the worker schedules the purge and runs it from the queue', async () => {
    await workMaintenance(boss, testDb.db, { info() {}, error() {} });
    const schedules = await boss.getSchedules();
    expect(schedules.map((s) => s.name)).toContain(PURGE_SIGNIN_TOKENS);

    const stale = ago(SIGNIN_TOKEN_RETENTION_MS + 3_600_000);
    await testDb.db.insert(signinTokens).values(row('queue@example.org', 'queue-old', stale));
    const id = await boss.send(PURGE_SIGNIN_TOKENS);
    if (!id) throw new Error('pg-boss did not accept the purge job');
    let job = await boss.getJobById(PURGE_SIGNIN_TOKENS, id);
    for (let i = 0; i < 40 && job?.state !== 'completed' && job?.state !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 250));
      job = await boss.getJobById(PURGE_SIGNIN_TOKENS, id);
    }
    expect(job?.state).toBe('completed');
    expect(job?.output).toMatchObject({ purged: 1 });
    const left = await testDb.db
      .select({ h: signinTokens.tokenHash })
      .from(signinTokens)
      .where(eq(signinTokens.email, 'queue@example.org'));
    expect(left).toEqual([]);
  });
});

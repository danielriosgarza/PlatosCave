import { and, count, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/client';
import { signinTokens } from '../db/schema';
import type { Mailer } from '../mail/mailer';
import type { IdentityProvider, SignInResult } from './identity-provider';
import { hashToken, newToken, TOKEN_SHAPE } from './sessions';

/** §3: expiring single-use links. */
export const LINK_TTL_MS = 15 * 60_000;
/** Links issued per address per LINK_TTL_MS; further requests are accepted but send nothing. */
export const LINKS_PER_EMAIL = 5;
/**
 * Links stay this long after expiry, then go. Until then an expired link keeps its destination
 * for the expired-link page (§3); after it, that page loses `next`.
 */
export const SIGNIN_TOKEN_RETENTION_MS = 24 * 3_600_000;

/**
 * Deletes links that expired more than a day ago, used or not; live and recently expired links
 * stay, so the per-address cap and the "link expired" answer keep working. No index serves this
 * (`expires_at` is unindexed); the hourly purge keeps the table to about a day of links.
 */
export async function purgeSigninTokens(db: Db, now: Date): Promise<number> {
  const result = await db
    .delete(signinTokens)
    .where(lt(signinTokens.expiresAt, new Date(now.getTime() - SIGNIN_TOKEN_RETENTION_MS)));
  return result.rowCount ?? 0;
}

export interface EmailProviderDeps {
  db: Db;
  mailer: Mailer;
  now: () => Date;
  /** Origin the link opens, e.g. https://parallax.example.org */
  appOrigin: string;
  log: FastifyBaseLogger;
}

export class EmailLinkProvider implements IdentityProvider {
  readonly id = 'email';

  constructor(private readonly deps: EmailProviderDeps) {}

  async begin({ email, destination }: { email: string; destination: string }): Promise<void> {
    const { db, now: clock, mailer, log } = this.deps;
    const address = email.toLowerCase();
    const now = clock();
    const token = newToken();
    // Count and insert under a per-address lock, so concurrent requests cannot all pass the cap.
    const row = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`signin:${address}`}))`);
      const [recent] = await tx
        .select({ n: count() })
        .from(signinTokens)
        .where(
          and(
            eq(signinTokens.email, address),
            gt(signinTokens.createdAt, new Date(now.getTime() - LINK_TTL_MS)),
          ),
        );
      if ((recent?.n ?? 0) >= LINKS_PER_EMAIL) return undefined;
      const [inserted] = await tx
        .insert(signinTokens)
        .values({
          email: address,
          tokenHash: hashToken(token),
          destination,
          createdAt: now,
          expiresAt: new Date(now.getTime() + LINK_TTL_MS),
        })
        .returning({ id: signinTokens.id });
      return inserted;
    });
    if (!row) {
      log.info('sign-in link not sent: per-address limit reached');
      return;
    }
    const link = new URL('/api/auth/verify', this.deps.appOrigin);
    link.searchParams.set('token', token);
    try {
      await mailer.send({
        to: address,
        subject: 'Sign in to Parallax',
        text: [
          'Open this link to sign in to Parallax:',
          '',
          link.toString(),
          '',
          'The link works once and expires in 15 minutes.',
          'If you did not ask to sign in, you can ignore this email.',
        ].join('\n'),
      });
    } catch (err) {
      // The answer stays 202 for every address; a delivery failure is an operator problem.
      // An undelivered link is removed so it does not use up one of the address's sends.
      log.error({ err }, 'sign-in link could not be sent');
      await db.delete(signinTokens).where(eq(signinTokens.id, row.id));
    }
  }

  async complete(token: string): Promise<SignInResult> {
    if (!TOKEN_SHAPE.test(token)) return { ok: false, destination: null };
    const { db, now: clock } = this.deps;
    const now = clock();
    const tokenHash = hashToken(token);
    // One conditional update: of two concurrent uses, exactly one gets the row back.
    const [used] = await db
      .update(signinTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(signinTokens.tokenHash, tokenHash),
          isNull(signinTokens.usedAt),
          gt(signinTokens.expiresAt, now),
        ),
      )
      .returning({ email: signinTokens.email, destination: signinTokens.destination });
    if (used) return { ok: true, email: used.email, destination: used.destination ?? '/courses' };
    const [known] = await db
      .select({ destination: signinTokens.destination })
      .from(signinTokens)
      .where(eq(signinTokens.tokenHash, tokenHash));
    return { ok: false, destination: known?.destination ?? null };
  }
}

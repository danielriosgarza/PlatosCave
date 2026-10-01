import type { FastifyBaseLogger } from 'fastify';
import type { BackgroundTasks } from '../background';
import {
  deleteSigninToken,
  deleteSigninTokensExpiredBefore,
  findSigninDestination,
  insertSigninTokenUnderCap,
  useSigninToken,
} from '../db/auth/signin-tokens';
import type { Db, Executor } from '../db/client';
import type { Mailer } from '../mail/mailer';
import type { IdentityProvider, SignInResult } from './identity-provider';
import { hashToken, newToken } from './sessions';

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
export function purgeSigninTokens(db: Db, now: Date): Promise<number> {
  return deleteSigninTokensExpiredBefore(db, new Date(now.getTime() - SIGNIN_TOKEN_RETENTION_MS));
}

/**
 * The parts of a delivery error that are safe to log: nodemailer's `envelope` and `rejected`
 * carry the recipient, and its message can quote the address, so the address is masked.
 */
const MIN_BARE_LOCAL = 6;

function describeMailError(err: unknown, address: string): Record<string, unknown> {
  const e = err as { message?: unknown; code?: unknown; responseCode?: unknown } | null;
  const message = typeof e?.message === 'string' ? e.message : String(err);
  const [local = ''] = address.split('@');
  // The address in any case, then a bare local part (relays often echo just that).
  const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let masked = message.replace(new RegExp(literal(address), 'gi'), '[address]');
  // A short local part (`no`, `info`, `user`) is also an ordinary word of the diagnostic, so
  // only longer ones are masked on their own. Lookarounds on the address characters, not `\\b`,
  // so one that starts or ends in punctuation (`-ops`, `john.`) is still found.
  if (local.length >= MIN_BARE_LOCAL) {
    masked = masked.replace(
      new RegExp(`(?<![A-Za-z0-9._%+-])${literal(local)}(?![A-Za-z0-9._%+-])`, 'gi'),
      '[address]',
    );
  }
  return {
    message: masked,
    code: e?.code,
    responseCode: e?.responseCode,
  };
}

export interface EmailProviderDeps {
  db: Db;
  mailer: Mailer;
  now: () => Date;
  /** Runs mail delivery after the request has been answered. */
  background: BackgroundTasks;
  /** Origin the link opens, e.g. https://parallax.example.org */
  appOrigin: string;
  log: FastifyBaseLogger;
}

export class EmailLinkProvider implements IdentityProvider {
  readonly id = 'email';

  constructor(private readonly deps: EmailProviderDeps) {}

  async begin({ email, destination }: { email: string; destination: string }): Promise<void> {
    const { db, now: clock, log } = this.deps;
    const address = email.toLowerCase();
    const now = clock();
    const token = newToken();
    // The per-address cap is checked and the link stored under one lock.
    const row = await insertSigninTokenUnderCap(
      db,
      {
        email: address,
        tokenHash: hashToken(token),
        destination,
        createdAt: now,
        expiresAt: new Date(now.getTime() + LINK_TTL_MS),
      },
      { since: new Date(now.getTime() - LINK_TTL_MS), limit: LINKS_PER_EMAIL },
    );
    if (!row) {
      log.info('sign-in link not sent: per-address limit reached');
      return;
    }
    const link = new URL('/api/auth/verify', this.deps.appOrigin);
    link.searchParams.set('token', token);
    // The row is committed; the caller answers 202 now and delivery follows. A hanging relay
    // then holds no request, and the response time does not tell a capped address from a
    // delivered one.
    this.deps.background.run(() => this.deliver(address, link.toString(), row.id));
  }

  private async deliver(address: string, link: string, rowId: string): Promise<void> {
    const { db, mailer, log } = this.deps;
    try {
      await mailer.send({
        to: address,
        subject: 'Sign in to Parallax',
        text: [
          'Open this link to sign in to Parallax:',
          '',
          link,
          '',
          'The link works once and expires in 15 minutes.',
          'If you did not ask to sign in, you can ignore this email.',
        ].join('\n'),
      });
    } catch (err) {
      // The answer was 202 for every address; a delivery failure is an operator problem.
      // Only the error's message and code are logged, never its envelope (the recipient).
      log.error({ ...describeMailError(err, address) }, 'sign-in link could not be sent');
      // An undelivered link is removed so it does not use up one of the address's sends. The
      // removal lands after the 202, so rapid retries while the relay is failing can reach the
      // cap before their rows go; accepted, since each row goes within the SMTP timeouts. When
      // the database is down alongside the mail transport the row stays and expires on its own.
      try {
        await deleteSigninToken(db, rowId);
      } catch (cleanup) {
        log.error(
          { ...describeMailError(cleanup, address) },
          'undelivered sign-in link could not be removed',
        );
      }
    }
  }

  /**
   * Finishes a sign-in from the link token. With `executor` the link is spent inside the
   * caller's transaction (verify's), so it stays usable if anything after it fails; that
   * guarantee belongs to this provider, not to `IdentityProvider`. A token that is not shaped
   * like ours simply matches no row; verify rejects those before opening a transaction.
   */
  async complete(token: string, executor?: Executor): Promise<SignInResult> {
    const { now: clock } = this.deps;
    const db = executor ?? this.deps.db;
    const now = clock();
    const tokenHash = hashToken(token);
    // One conditional update: of two concurrent uses, exactly one gets the row back.
    const used = await useSigninToken(db, tokenHash, now);
    if (used) return { ok: true, email: used.email, destination: used.destination ?? '/courses' };
    return { ok: false, destination: await findSigninDestination(db, tokenHash) };
  }
}

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
import { hashToken, newToken } from './tokens';

/** §3: expiring single-use links. */
export const LINK_TTL_MS = 15 * 60_000;
/**
 * The per-address cap. Anyone can ask for a link to any address, so the cap has two jobs that
 * pull apart: keep a stranger from flooding the address with mail, and keep that stranger from
 * using the cap to stop the owner signing in (§3).
 *
 * - At most LINKS_PER_EMAIL unused links per LINK_TTL_MS (a link younger than LINK_TTL_MS is
 *   also unexpired). Used links do not count, so an owner who signs in repeatedly is never
 *   capped by their own sign-ins.
 * - Past the cap, one more link once the address's newest link is LINK_FLOOR_MS old. Requests
 *   inside the floor are accepted but send nothing.
 *
 * Trade-off: a stranger can make the address receive LINKS_PER_EMAIL links at once and then one
 * a minute (about 19 per 15 minutes per address, each an ordinary link to the owner's own
 * inbox), and an owner whose request lands inside a stranger's minute waits at most a minute
 * for the next. In return a stranger can no longer silence the address: each link mailed to it,
 * whoever asked, signs its owner in. Every request answers the same 202 either way, so neither
 * branch tells a known address from an unknown one.
 */
export const LINKS_PER_EMAIL = 5;
export const LINK_FLOOR_MS = 60_000;
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
  const e = err as {
    message?: unknown;
    code?: unknown;
    responseCode?: unknown;
  } | null;
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

/**
 * One delivery, however many SMTP phases it spans, is given up after this long. It sits inside
 * the 8 s drain in app.ts (itself inside the 10 s stop grace), so a shutdown waits for the
 * compensating delete rather than abandoning the task before it runs.
 */
export const DELIVERY_TIMEOUT_MS = 6_000;

/** Rejects after `ms`; the `send` keeps running unobserved, so a late failure is swallowed. */
async function withDeadline(send: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(new Error(`mail delivery exceeded ${ms} ms`), {
            code: 'ETIMEDOUT',
          }),
        ),
      ms,
    );
  });
  send.catch(() => {});
  try {
    await Promise.race([send, late]);
  } finally {
    clearTimeout(timer);
  }
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
  /** Deadline for one whole delivery; defaults to DELIVERY_TIMEOUT_MS. */
  deliveryTimeoutMs?: number;
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
      {
        since: new Date(now.getTime() - LINK_TTL_MS),
        limit: LINKS_PER_EMAIL,
        floorSince: new Date(now.getTime() - LINK_FLOOR_MS),
      },
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
      await withDeadline(
        mailer.send({
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
        }),
        this.deps.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS,
      );
    } catch (err) {
      // The answer was 202 for every address; a delivery failure is an operator problem.
      // Only the error's message and code are logged, never its envelope (the recipient).
      log.error({ ...describeMailError(err, address) }, 'sign-in link could not be sent');
      // An undelivered link is removed so it does not use up one of the address's sends. The
      // removal lands after the 202, so rapid retries while the relay is failing can reach the
      // cap before their rows go; accepted, since each row goes within DELIVERY_TIMEOUT_MS. A send that completes after the deadline has mailed a link whose row is gone; it opens the expired-link page. When
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
   * like ours simply matches no row; verify rejects those before opening a transaction, and
   * `IdentityProvider.complete` says its caller must.
   */
  async complete(token: string, executor?: Executor): Promise<SignInResult> {
    const { now: clock } = this.deps;
    const db = executor ?? this.deps.db;
    const now = clock();
    const tokenHash = hashToken(token);
    // One conditional update: of two concurrent uses, exactly one gets the row back.
    const used = await useSigninToken(db, tokenHash, now);
    if (used)
      return {
        ok: true,
        email: used.email,
        destination: used.destination ?? '/courses',
      };
    return {
      ok: false,
      destination: await findSigninDestination(db, tokenHash),
    };
  }
}

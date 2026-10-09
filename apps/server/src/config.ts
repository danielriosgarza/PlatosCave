import { isIP } from 'node:net';
import { z } from 'zod';

/** Used outside production only, so a fresh checkout runs without configuration. */
export const DEV_SESSION_SECRET = 'parallax-development-session-secret-not-for-production';
export const DEV_CONTENT_TOKEN_SECRET = 'parallax-development-content-secret-not-for-production';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/** A bare host name (no scheme, port or path), compared with each request's host name. */
const HostName = z
  .string()
  .regex(/^[A-Za-z0-9.-]+$|^\[[0-9A-Fa-f:]+\]$/, 'a host name without scheme or port')
  .transform((h) => h.toLowerCase());

/** One `trustProxy` entry as proxy-addr reads it: an address, an address/prefix, or a keyword. */
function isProxyAddress(entry: string): boolean {
  if (['loopback', 'linklocal', 'uniquelocal'].includes(entry)) return true;
  const [address = '', prefix, ...rest] = entry.split('/');
  const family = isIP(address);
  if (family === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}

/**
 * One approved runtime a code question may select (docs/design/runner.md §6.3). `image` is the
 * reference the runner allowlists; production pins it by `digest`.
 */
const RunnerRuntime = z.strictObject({
  id: z.string().regex(/^(python|r)-[0-9]+\.[0-9]+$/),
  language: z.enum(['python', 'r']),
  image: z.string().min(1),
  digest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .nullable(),
  harnessVersion: z.string().regex(/^[0-9]+$/),
  packages: z.array(z.string().min(1)),
});
export type RunnerRuntime = z.infer<typeof RunnerRuntime>;

/** Development and CI: the images `scripts/runner-image.sh build python|r` tag `:dev`. */
export const DEV_RUNNER_RUNTIMES: RunnerRuntime[] = [
  {
    id: 'python-3.12',
    language: 'python',
    image: 'parallax-runner-python:dev',
    digest: null,
    harnessVersion: '4',
    packages: ['numpy', 'pandas', 'scipy'],
  },
  {
    id: 'r-4.6',
    language: 'r',
    image: 'parallax-runner-r:dev',
    digest: null,
    harnessVersion: '4',
    packages: ['jsonlite'],
  },
];

const Env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().default(3000),
    HOST: z.string().default('127.0.0.1'),
    DATABASE_URL: z.string().optional(),
    STATIC_DIR: z.string().optional(),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** Signs the session cookie. Required in production. */
    SESSION_SECRET: z.string().min(32).optional(),
    /** Origin people open the app at; sign-in links point here. Required in production. */
    APP_ORIGIN: z
      .url()
      .transform((u) => new URL(u).origin)
      .optional(),
    MAIL_TRANSPORT: z.enum(['file', 'smtp']).default('file'),
    /** `file` transport: one JSON file per message (ADR-0001). */
    MAIL_DIR: z.string().default('.local/mail'),
    /** Sender of sign-in mail. Required for `smtp` (relays reject the placeholder). */
    MAIL_FROM: z.string().optional(),
    /** `smtp` transport, e.g. smtp://user:pass@mail.example.org:587 */
    SMTP_URL: z.string().optional(),
    /**
     * Sign-in link requests allowed per client IP per 15 minutes. The per-address cap (five
     * unused links, then one a minute; auth/email-provider.ts) is what bounds mail floods; this
     * one slows address guessing. Sized for a class signing in together from one campus NAT (a
     * few dozen people, with retries).
     */
    AUTH_LINK_RATE_LIMIT: z.coerce.number().int().positive().default(120),
    /** Sign-in link uses (`/api/auth/verify`) allowed per client IP per 15 minutes. */
    AUTH_VERIFY_RATE_LIMIT: z.coerce.number().int().positive().default(240),
    /** Notebook uploads (`notebook-submissions`) one person may make per 15 minutes (§13). */
    SUBMISSION_RATE_LIMIT: z.coerce.number().int().positive().default(30),
    /**
     * Code-run requests (sample runs, replays, instructor previews) allowed per session per
     * minute. Counted per session, not per address, so a class behind one campus NAT, or the load
     * test's single client, does not share a budget. A student's runs are also capped at two
     * queued or running (spec §11), whatever this is.
     */
    RUN_RATE_LIMIT: z.coerce.number().int().positive().default(30),
    /**
     * `GET /api/ready` answers 200/503 with the version, mode and per-dependency detail only to a
     * request bearing `X-Ready-Token` equal to READY_PROBE_TOKEN (the compose health check inside
     * the container, a proxy's or monitor's probe). Anyone else gets the status alone, and at
     * most READY_RATE_LIMIT such requests per address per minute, because every answer runs a
     * database query and a storage call. Requests with the token are never limited. `GET
     * /api/health` follows the same rule (version and database state for a probe, `status` alone
     * and the same per-address limit, with its own budget, for everyone else).
     */
    READY_PROBE_TOKEN: z.string().trim().min(16).optional(),
    READY_RATE_LIMIT: z.coerce.number().int().positive().default(30),
    /** Days a sign-in lasts before the person signs in again (spec §17: session limits). */
    SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
    /**
     * Default lease of a notebook session when neither the person nor the class template sets
     * one (connector design §9): minutes without activity before an open notebook stops, and
     * minutes a closed tab keeps its kernel. Bounds are the connector's: 5-240 and 1-60.
     */
    LEASE_IDLE_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
    LEASE_GRACE_MINUTES: z.coerce.number().int().min(1).max(60).default(5),
    /**
     * Fastify `trustProxy`: which proxies' `X-Forwarded-*` headers to believe, so `req.ip` (the
     * rate-limit key) and `req.host` name the client and the requested host, not the proxy.
     * Prefer a comma-separated list of your proxies' addresses / CIDR ranges: `req.ip` is then
     * the first address that is not one of them, which the client cannot choose. `true` believes
     * every hop, so `req.ip` is the leftmost `X-Forwarded-For` entry; a proxy that appends to
     * the header (nginx's `$proxy_add_x_forwarded_for`) lets a client pick it per request and
     * void the per-IP limits, so use `true` only when the proxy replaces the header. `false`
     * (default outside production) ignores the headers. A bare hop count is refused: Fastify 5
     * treats it as "trust nobody" because it cannot check the peer. Production requires it set
     * explicitly: behind a proxy, `false` makes every client share the proxy's address and so
     * one per-IP sign-in budget.
     */
    TRUST_PROXY: z
      .string()
      .optional()
      .transform((v): boolean | string[] | undefined => {
        if (v === undefined) return undefined;
        const value = v.trim();
        if (value.toLowerCase() === 'true') return true;
        if (value.toLowerCase() === 'false') return false;
        return value.split(',').map((a) => a.trim());
      })
      .refine((v) => !Array.isArray(v) || v.every(isProxyAddress), {
        message:
          'true, false, or a comma-separated list of proxy addresses, CIDR ranges or loopback / linklocal / uniquelocal',
      }),
    /**
     * Two host names for one server (ADR-0002): the app (API, web) and the content origin,
     * which serves only `/content/:token`. Development defaults match Vite on localhost:5173.
     */
    APP_HOST: HostName.default('localhost'),
    CONTENT_HOST: HostName.default('127.0.0.1'),
    /** Base of minted content URLs; defaults to http://CONTENT_HOST:PORT. Required in production. */
    CONTENT_ORIGIN: z
      .url()
      .transform((u) => new URL(u).origin)
      .optional(),
    /**
     * Origins a Shiny resource may be embedded from (§10.7), comma-separated. A resource whose
     * address is on another origin is neither framed nor linked. Each entry is https, or http on
     * a loopback host for development.
     */
    SHINY_ORIGINS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean),
      )
      .pipe(
        z.array(
          z.url().transform((u, ctx) => {
            const url = new URL(u);
            const local =
              url.protocol === 'http:' && (LOOPBACK.has(url.hostname) || url.hostname === '[::1]');
            if (url.protocol !== 'https:' && !local) {
              ctx.addIssue({ code: 'custom', message: 'https, or http on a loopback host' });
            }
            return url.origin;
          }),
        ),
      ),
    /**
     * Who may create a course without already teaching (owner decision on #242), as a
     * comma-separated list of email addresses, compared trimmed and case-insensitively with the
     * signed-in account's address (every account's address was proven by a sign-in link). Read
     * at start-up; empty keeps the rule that only people who already teach create courses.
     */
    INSTRUCTOR_EMAILS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean),
      )
      .pipe(z.array(z.email())),
    /**
     * Retention policy (§13), applied by the daily retention job. Each rule is off while unset,
     * so nothing is removed until the operator decides: days a deactivated account waits before
     * its identity is anonymised, and days an audit event is kept.
     */
    RETENTION_DEACTIVATED_GRACE_DAYS: z.coerce.number().int().min(0).optional(),
    RETENTION_AUDIT_DAYS: z.coerce.number().int().min(1).optional(),
    /** HMAC key for content tokens. Required in production and off loopback. */
    CONTENT_TOKEN_SECRET: z.string().min(32).optional(),
    STORAGE_DRIVER: z.enum(['fs', 's3']).default('fs'),
    /** `fs` driver: root directory of the object store. */
    STORAGE_DIR: z.string().default('.local/storage'),
    /** `s3` driver (any S3-compatible service; Garage in development and CI). */
    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().default('garage'),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    /**
     * The runtimes code questions may select, as a JSON array (docs/design/runner.md §6.3).
     * Production requires a `digest` on every entry.
     */
    RUNNER_RUNTIMES: z
      .string()
      .optional()
      .transform((v, ctx): RunnerRuntime[] | undefined => {
        if (v === undefined) return undefined;
        try {
          return JSON.parse(v);
        } catch {
          ctx.addIssue({ code: 'custom', message: 'a JSON array of runtimes' });
          return z.NEVER;
        }
      })
      .pipe(z.array(RunnerRuntime).optional())
      .refine((list) => !list || new Set(list.map((r) => r.id)).size === list.length, {
        message: 'runtime ids must be unique',
      }),
    /** `1` mounts the e2e fixture routes under /api/test (ADR-0006); refused in production. */
    TEST_ROUTES: z
      .enum(['0', '1'])
      .default('0')
      .transform((v) => v === '1'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      for (const key of [
        'SESSION_SECRET',
        'APP_ORIGIN',
        'CONTENT_ORIGIN',
        'CONTENT_TOKEN_SECRET',
      ] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required' });
      }
      if (env.TRUST_PROXY === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['TRUST_PROXY'],
          message:
            "required in production: your proxies' addresses / CIDR ranges, true, or false when no proxy sits in front (otherwise every client shares the proxy's rate limits)",
        });
      }
    }
    if (env.NODE_ENV === 'production' && env.RUNNER_RUNTIMES?.some((r) => r.digest === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['RUNNER_RUNTIMES'],
        message: 'every runtime needs a digest in production',
      });
    }
    if (env.NODE_ENV === 'production' && env.TEST_ROUTES) {
      ctx.addIssue({ code: 'custom', path: ['TEST_ROUTES'], message: 'not allowed in production' });
    }
    // The fixture routes only answer loopback peers; a server reachable beyond this machine
    // must not mount them in any mode.
    if (env.TEST_ROUTES && !LOOPBACK.has(env.HOST)) {
      ctx.addIssue({
        code: 'custom',
        path: ['TEST_ROUTES'],
        message: 'not allowed when HOST is not a loopback address',
      });
    }
    if (env.MAIL_TRANSPORT === 'smtp' && !env.SMTP_URL) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_URL'], message: 'required for smtp' });
    }
    if (env.MAIL_TRANSPORT === 'smtp' && !env.MAIL_FROM) {
      ctx.addIssue({ code: 'custom', path: ['MAIL_FROM'], message: 'required for smtp' });
    }
    if (env.APP_HOST === env.CONTENT_HOST) {
      ctx.addIssue({
        code: 'custom',
        path: ['CONTENT_HOST'],
        message: 'must differ from APP_HOST',
      });
    }
    // The development secret is public: anything reachable beyond this machine needs its own,
    // whatever NODE_ENV says.
    if (!LOOPBACK.has(env.HOST) && !env.CONTENT_TOKEN_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['CONTENT_TOKEN_SECRET'],
        message: 'required when HOST is not a loopback address',
      });
    }
    if (env.CONTENT_ORIGIN && new URL(env.CONTENT_ORIGIN).hostname !== env.CONTENT_HOST) {
      ctx.addIssue({
        code: 'custom',
        path: ['CONTENT_ORIGIN'],
        message: 'host must be CONTENT_HOST',
      });
    }
    // A Shiny frame keeps its own origin's scripts and storage; the app's origin or host would
    // hand it the session and /api.
    const own = new Set(
      [
        env.APP_ORIGIN ?? 'http://localhost:5173',
        env.CONTENT_ORIGIN ?? `http://${env.CONTENT_HOST}:${env.PORT}`,
      ].map((o) => new URL(o).origin),
    );
    for (const origin of env.SHINY_ORIGINS) {
      const { hostname } = new URL(origin);
      // Cookies ignore ports: the app's host on any port would receive the session cookie.
      if (own.has(origin) || hostname === env.APP_HOST) {
        ctx.addIssue({
          code: 'custom',
          path: ['SHINY_ORIGINS'],
          message: `${origin} is the app or content origin`,
        });
      }
    }
    if (env.STORAGE_DRIVER === 's3') {
      for (const key of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required for s3' });
      }
    }
  })
  .transform((env) => ({
    ...env,
    SESSION_SECRET: env.SESSION_SECRET ?? DEV_SESSION_SECRET,
    TRUST_PROXY: env.TRUST_PROXY ?? false,
    /** SESSION_TTL_DAYS in milliseconds: the one lifetime every session and its cookies get. */
    SESSION_TTL_MS: env.SESSION_TTL_DAYS * 24 * 60 * 60_000,
    MAIL_FROM: env.MAIL_FROM ?? 'Parallax <no-reply@parallax.invalid>',
    // The Vite dev server proxies /api, so links open the web app's origin in development.
    APP_ORIGIN: env.APP_ORIGIN ?? 'http://localhost:5173',
    CONTENT_ORIGIN: env.CONTENT_ORIGIN ?? `http://${env.CONTENT_HOST}:${env.PORT}`,
    CONTENT_TOKEN_SECRET: env.CONTENT_TOKEN_SECRET ?? DEV_CONTENT_TOKEN_SECRET,
    // Production approves only what it lists; elsewhere the locally built image is the default.
    RUNNER_RUNTIMES:
      env.RUNNER_RUNTIMES ?? (env.NODE_ENV === 'production' ? [] : DEV_RUNNER_RUNTIMES),
  }));

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An empty value (as in .env.example) means "unset".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  return Env.parse(cleaned);
}

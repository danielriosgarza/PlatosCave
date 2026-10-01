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
     * links) is what stops mail floods; this one slows address guessing. Sized for a class
     * signing in together from one campus NAT (a few dozen people, with retries).
     */
    AUTH_LINK_RATE_LIMIT: z.coerce.number().int().positive().default(120),
    /** Sign-in link uses (`/api/auth/verify`) allowed per client IP per 15 minutes. */
    AUTH_VERIFY_RATE_LIMIT: z.coerce.number().int().positive().default(240),
    /**
     * Fastify `trustProxy`: which proxies' `X-Forwarded-*` headers to believe, so `req.ip` (the
     * rate-limit key) and `req.host` name the client and the requested host, not the proxy.
     * `false` (default), `true` (every hop; only when the app is reachable through the proxy
     * alone), or a comma-separated list of proxy addresses / CIDR ranges. A bare hop count is
     * refused: Fastify 5 treats it as "trust nobody" because it cannot check the peer.
     */
    TRUST_PROXY: z
      .string()
      .default('false')
      .transform((v): boolean | string[] => {
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
    }
    if (env.NODE_ENV === 'production' && env.TEST_ROUTES) {
      ctx.addIssue({ code: 'custom', path: ['TEST_ROUTES'], message: 'not allowed in production' });
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
    // whatever NODE_ENV says (tests excepted: e2e listens on 0.0.0.0 inside the runner).
    if (env.NODE_ENV !== 'test' && !LOOPBACK.has(env.HOST) && !env.CONTENT_TOKEN_SECRET) {
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
    if (env.STORAGE_DRIVER === 's3') {
      for (const key of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required for s3' });
      }
    }
  })
  .transform((env) => ({
    ...env,
    SESSION_SECRET: env.SESSION_SECRET ?? DEV_SESSION_SECRET,
    MAIL_FROM: env.MAIL_FROM ?? 'Parallax <no-reply@parallax.invalid>',
    // The Vite dev server proxies /api, so links open the web app's origin in development.
    APP_ORIGIN: env.APP_ORIGIN ?? 'http://localhost:5173',
    CONTENT_ORIGIN: env.CONTENT_ORIGIN ?? `http://${env.CONTENT_HOST}:${env.PORT}`,
    CONTENT_TOKEN_SECRET: env.CONTENT_TOKEN_SECRET ?? DEV_CONTENT_TOKEN_SECRET,
  }));

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An empty value (as in .env.example) means "unset".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  return Env.parse(cleaned);
}

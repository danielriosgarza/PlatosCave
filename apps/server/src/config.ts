import { z } from 'zod';

/** Used outside production only, so a fresh checkout runs without configuration. */
export const DEV_CONTENT_TOKEN_SECRET = 'parallax-development-content-secret-not-for-production';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/** A bare host name (no scheme, port or path), compared with each request's host name. */
const HostName = z
  .string()
  .regex(/^[A-Za-z0-9.-]+$|^\[[0-9A-Fa-f:]+\]$/, 'a host name without scheme or port')
  .transform((h) => h.toLowerCase());

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
    /** HMAC key for content tokens. Required in production. */
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
  })
  .superRefine((env, ctx) => {
    if (env.APP_HOST === env.CONTENT_HOST) {
      ctx.addIssue({
        code: 'custom',
        path: ['CONTENT_HOST'],
        message: 'must differ from APP_HOST',
      });
    }
    if (env.NODE_ENV === 'production') {
      for (const key of ['CONTENT_ORIGIN', 'CONTENT_TOKEN_SECRET'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required' });
      }
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
    CONTENT_ORIGIN: env.CONTENT_ORIGIN ?? `http://${env.CONTENT_HOST}:${env.PORT}`,
    CONTENT_TOKEN_SECRET: env.CONTENT_TOKEN_SECRET ?? DEV_CONTENT_TOKEN_SECRET,
  }));

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An empty value (as in .env.example) means "unset".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  return Env.parse(cleaned);
}

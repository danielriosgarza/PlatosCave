import { z } from 'zod';

/** Used outside production only, so a fresh checkout runs without configuration. */
export const DEV_SESSION_SECRET = 'parallax-development-session-secret-not-for-production';

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
    MAIL_FROM: z.string().default('Parallax <no-reply@parallax.invalid>'),
    /** `smtp` transport, e.g. smtp://user:pass@mail.example.org:587 */
    SMTP_URL: z.string().optional(),
    /** Sign-in link requests allowed per client IP per 15 minutes. */
    AUTH_LINK_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      for (const key of ['SESSION_SECRET', 'APP_ORIGIN'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required' });
      }
    }
    if (env.MAIL_TRANSPORT === 'smtp' && !env.SMTP_URL) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_URL'], message: 'required for smtp' });
    }
  })
  .transform((env) => ({
    ...env,
    SESSION_SECRET: env.SESSION_SECRET ?? DEV_SESSION_SECRET,
    // The Vite dev server proxies /api, so links open the web app's origin in development.
    APP_ORIGIN: env.APP_ORIGIN ?? 'http://localhost:5173',
  }));

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An empty value (as in .env.example) means "unset".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  return Env.parse(cleaned);
}

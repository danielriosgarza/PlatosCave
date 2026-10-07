import pino, { type DestinationStream, type LoggerOptions } from 'pino';
import type { Config } from './config';

/**
 * Keys whose values may be private content or credentials (spec §13: "Private content is not sent
 * to ... public logs"): request and message bodies, uploads, answers and code, mail addresses,
 * cookies and tokens, connection strings. A log call that passes one has the value removed, at
 * the top level or one level down (`{ req: { body } }`), so an object logged whole by mistake
 * loses its contents. Log lines carry ids, counts, states and error codes instead.
 */
const PRIVATE_KEYS = [
  'body',
  'payload',
  'content',
  'text',
  'files',
  'answers',
  'source',
  'stdin',
  'stdout',
  'stderr',
  'email',
  'address',
  'recipient',
  'to',
  'headers',
  'cookie',
  'cookies',
  'set-cookie',
  'authorization',
  'token',
  'password',
  'secret',
  'sessionToken',
  'nonce',
  'databaseUrl',
  'smtpUrl',
] as const;

/** A pino redact path for `key` below `prefix` (`a.b` or `a["b-c"]`); `prefix` may be empty. */
const redactPath = (prefix: string, key: string) =>
  /^[A-Za-z_$][\w$]*$/.test(key) ? `${prefix}${prefix ? '.' : ''}${key}` : `${prefix}["${key}"]`;

export const REDACT_PATHS = PRIVATE_KEYS.flatMap((key) => [
  redactPath('', key),
  redactPath('*', key),
  redactPath('req.headers', key),
  redactPath('res.headers', key),
]);

/** Fields of a database error that quote row values, SQL and parameters. */
const QUOTING_FIELDS = [
  'detail',
  'where',
  'hint',
  'internalQuery',
  'parameters',
  'params',
  'query',
  'values',
];

type Serialised = Record<string, unknown>;
type ErrorLike = {
  name?: unknown;
  code?: unknown;
  params?: unknown;
  query?: unknown;
  cause?: unknown;
};

/**
 * Whether the error, or one it wraps, was raised by a query: drizzle's `DrizzleQueryError` puts
 * the SQL and the bound values in its message (`Failed query: … params: …`), and pino folds each
 * cause's message and stack into the error's own.
 */
function wrapsQuery(err: unknown): boolean {
  for (let e = err as ErrorLike | undefined, depth = 0; e && depth < 8; depth++) {
    if (e.name === 'DrizzleQueryError' || 'params' in e || 'query' in e) return true;
    e = e.cause as ErrorLike | undefined;
  }
  return false;
}

/** The first error code in the chain (a Postgres SQLSTATE such as `23505`), if any. */
function codeOf(err: unknown): string | undefined {
  for (let e = err as ErrorLike | undefined, depth = 0; e && depth < 8; depth++) {
    if (typeof e.code === 'string') return e.code;
    e = e.cause as ErrorLike | undefined;
  }
  return undefined;
}

/**
 * pino's error serializer minus what a database library copies from private input: the fields
 * above are dropped, and a failed query keeps only its error code, because its message, stack and
 * causes all quote the SQL and the bound values.
 */
export function serialiseError(err: unknown): unknown {
  const out = pino.stdSerializers.err(err as Error) as Serialised;
  for (const field of QUOTING_FIELDS) delete out[field];
  if (wrapsQuery(err)) {
    const code = codeOf(err);
    out.message = `database query failed${code ? ` (${code})` : ''}`;
    out.stack = `${String(out.type ?? 'Error')}: ${out.message}`;
    if (code) out.code = code;
  }
  return out;
}

/** Options shared by the API's Fastify logger and the worker's pino logger. */
export function loggerOptions(config: Pick<Config, 'LOG_LEVEL'>): LoggerOptions {
  return {
    level: config.LOG_LEVEL,
    redact: { paths: [...REDACT_PATHS], remove: true },
    serializers: { err: serialiseError },
  };
}

/** The worker's logger. */
export function createLogger(
  config: Pick<Config, 'LOG_LEVEL'>,
  name: string,
  destination?: DestinationStream,
) {
  const options = { ...loggerOptions(config), name };
  return destination ? pino(options, destination) : pino(options);
}

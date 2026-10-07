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

// `headers` is itself a private key, so `*.headers` removes request and response headers whole.
export const REDACT_PATHS = PRIVATE_KEYS.flatMap((key) => [
  redactPath('', key),
  redactPath('*', key),
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
  severity?: unknown;
  cause?: unknown;
};

const isObject = (value: unknown): value is ErrorLike =>
  typeof value === 'object' && value !== null;

/** The error and what it wraps, as far as each link is an object (a cause may be a string). */
function* chain(err: unknown): Generator<ErrorLike> {
  let e: unknown = err;
  for (let depth = 0; isObject(e) && depth < 8; depth++) {
    yield e;
    e = e.cause;
  }
}

/**
 * Whether the error, or one it wraps, came from the database: drizzle's `DrizzleQueryError` puts
 * the SQL and the bound values in its message (`Failed query: … params: …`), a `pg` error carries
 * a `severity` and its message can quote the offending input (`invalid input syntax for type
 * uuid: "…"`), and pino folds each cause's message and stack into the error's own.
 */
const fromDatabase = (err: unknown): boolean =>
  [...chain(err)].some(
    (e) =>
      e.name === 'DrizzleQueryError' ||
      'params' in e ||
      'query' in e ||
      typeof e.severity === 'string',
  );

/** The first error code in the chain (a Postgres SQLSTATE such as `23505`), if any. */
const codeOf = (err: unknown): string | undefined =>
  [...chain(err)].find((e) => typeof e.code === 'string')?.code as string | undefined;

/**
 * pino's error serializer minus what a database library copies from private input: the fields
 * above are dropped, and an error from the database keeps only its error code, because its
 * message, stack and causes all quote the SQL and the bound values. Never throws, and never
 * changes what the caller passed: a value pino does not turn into a new object (a string, null, a
 * plain object) is returned as it came.
 */
export function serialiseError(err: unknown): unknown {
  const out = pino.stdSerializers.err(err as Error) as unknown;
  if (!isObject(out) || out === err) return out;
  const serialised = out as Serialised;
  for (const field of QUOTING_FIELDS) delete serialised[field];
  if (fromDatabase(err)) {
    const code = codeOf(err);
    serialised.message = `database query failed${code ? ` (${code})` : ''}`;
    serialised.stack = `${String(serialised.type ?? 'Error')}: ${serialised.message}`;
    if (code) serialised.code = code;
  }
  return serialised;
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

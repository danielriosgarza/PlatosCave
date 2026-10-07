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

/** Fields of a Postgres error that quote row values, SQL and parameters. */
const QUOTING_FIELDS = [
  'detail',
  'where',
  'hint',
  'internalQuery',
  'parameters',
  'query',
  'values',
];

type Serialised = Record<string, unknown>;

/** pino's error serializer minus what a database or client library copies from private input. */
export function serialiseError(err: unknown): unknown {
  const out = pino.stdSerializers.err(err as Error) as Serialised;
  for (const field of QUOTING_FIELDS) delete out[field];
  if (out.cause && typeof out.cause === 'object') out.cause = serialiseError(out.cause);
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

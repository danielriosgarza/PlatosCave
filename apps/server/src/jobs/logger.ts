import type { FastifyBaseLogger } from 'fastify';

/** What worker code logs through: the API's logger in tests, a pino logger in the worker. */
export type JobLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

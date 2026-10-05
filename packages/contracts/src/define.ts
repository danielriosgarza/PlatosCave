import { z } from 'zod';

export type Scope =
  | { kind: 'public' }
  | { kind: 'user' }
  | { kind: 'system' }
  | {
      kind: 'class';
      role: 'student' | 'instructor' | 'any';
      grant?: 'manage_members';
    }
  | { kind: 'course'; role: 'editor' | 'publisher' | 'owner' };

/** The runtime check of a declared scope, for declarations loaded from modules (jobs). */
export const Scope: z.ZodType<Scope> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('public') }),
  z.strictObject({ kind: z.literal('user') }),
  z.strictObject({ kind: z.literal('system') }),
  z.strictObject({
    kind: z.literal('class'),
    role: z.enum(['student', 'instructor', 'any']),
    grant: z.literal('manage_members').optional(),
  }),
  z.strictObject({
    kind: z.literal('course'),
    role: z.enum(['editor', 'publisher', 'owner']),
  }),
]);

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A contract part that may be absent: `undefined` when the contract omits it. */
type Part = z.ZodType | undefined;
type InputOf<T extends Part> = T extends z.ZodType ? z.input<T> : never;

/**
 * Error statuses a handler may answer with itself, declared per route in `errors` (ADR-0002
 * §Error replies): 400 input the route cannot apply, 403 a refusal the scope does not decide,
 * 404 a named missing thing, 409 a state conflict, 410 something used up, 413 a file over the
 * limit, 422 a domain validation report, 429 a rate limit.
 */
export type ErrorStatus = 400 | 403 | 404 | 409 | 410 | 413 | 422 | 429;
/** Declared error bodies by status; every body is `{ error, … }`. */
export type Errors = { [S in ErrorStatus]?: z.ZodType };

export interface RouteContract<
  P extends Part = Part,
  Q extends Part = Part,
  B extends Part = Part,
  R extends z.ZodType = z.ZodType,
  S extends Scope = Scope,
  E extends Errors | undefined = Errors | undefined,
> {
  method: Method;
  path: `/api/${string}`;
  scope: S;
  summary: string;
  /**
   * A WebSocket endpoint (docs/design/connector.md §10.1): `GET` only. The scope is resolved
   * before the upgrade, so a refusal is the usual HTTP answer and no socket is opened; a plain
   * `GET` without an upgrade answers the shared 404. `response` documents nothing for it.
   */
  websocket?: true;
  /** Success status; defaults to 200. A 302 route answers with a redirect and no body. */
  status?: 200 | 201 | 202 | 302;
  /**
   * A second success status the handler may choose with `reply.code`, answered with the same
   * `response` schema (a request that found its work already done answers 200 instead of 202).
   */
  alternativeStatus?: 200;
  params?: P;
  query?: Q;
  body?: B;
  response: R;
  /**
   * Every error status the handler can answer, with its body. Statuses the contract's scope and
   * parts already imply (see `errorResponses`) need not be repeated; declaring one narrows the
   * documented body and keeps the implied one valid.
   */
  errors?: E;
  /**
   * Valid example inputs; the isolation matrix (ADR-0002) replays every contract with them,
   * substituting the fixture world's ids for `classId` and `courseId`.
   */
  examples: { params?: InputOf<P>; query?: InputOf<Q>; body?: InputOf<B> };
}

/** Omitted parts default to `undefined`, so handlers see `params: undefined` rather than `unknown`. */
export function defineRoute<
  R extends z.ZodType,
  S extends Scope,
  P extends Part = undefined,
  Q extends Part = undefined,
  B extends Part = undefined,
  E extends Errors | undefined = undefined,
>(c: RouteContract<P, Q, B, R, S, E>): RouteContract<P, Q, B, R, S, E> {
  return c;
}

/**
 * The one error body: `error` is a short, non-identifying code. Refusals raised by Fastify or a
 * plugin (schema validation, a stale sign-in, an unavailable database, a rate limit) also carry
 * Fastify's `message`, `code` and `statusCode`; a route's own refusal adds only what its
 * contract declares.
 */
export const errorBody = z.object({
  error: z.string(),
  message: z.string().optional(),
  code: z.string().optional(),
  statusCode: z.number().int().optional(),
});

/** 409 for a write to an archived class: it keeps read access and refuses writes (§4). */
export const classArchived = z.object({ error: z.literal('class_archived') });

/** 400 for a request the service refused as written, with the sentence to show (`Outcome`). */
export const invalidBody = z.object({
  error: z.literal('invalid'),
  message: z.string(),
});

/**
 * Every error status a route can answer, with its body: those its scope and parts imply, and
 * those it declares in `errors`. registerRoute documents exactly these in OpenAPI and answers
 * 500 instead of any other 4xx.
 *
 * - 400 when the route takes params, a query or a body (schema validation);
 * - 401 for every non-public scope (no session, or a sign-in too old for the change);
 * - 403 when the scope names a class role, a grant or a course grant (ADR-0002);
 * - 404 for every route (unknown, foreign or missing; one body);
 * - 503 for every route (the database or another dependency is not configured).
 */
export function errorResponses(contract: RouteContract): Partial<Record<number, z.ZodType>> {
  const { scope } = contract;
  const forbids =
    (scope.kind === 'class' && (scope.role !== 'any' || scope.grant !== undefined)) ||
    scope.kind === 'course';
  const implied: Partial<Record<number, z.ZodType>> = {
    ...((contract.params || contract.query || contract.body) && {
      400: errorBody,
    }),
    ...(scope.kind !== 'public' && { 401: errorBody }),
    ...(forbids && { 403: errorBody }),
    404: errorBody,
    503: errorBody,
  };
  const out = { ...implied };
  for (const [key, body] of Object.entries(contract.errors ?? {})) {
    if (!body) continue;
    const status = Number(key);
    const shared = implied[status];
    out[status] = shared ? z.union([body, shared]) : body;
  }
  return out;
}

/**
 * 409 body of an optimistic revision check (ADR-0003, §12 "never overwrite silently"): the
 * server's current copy, so an editor can show a conflict view instead of overwriting.
 */
export const conflictBody = <T extends z.ZodType>(current: T) =>
  z.object({ error: z.literal('revision_conflict'), current });

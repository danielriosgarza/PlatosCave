import { z } from 'zod';

export type Scope =
  | { kind: 'public' }
  | { kind: 'user' }
  | { kind: 'system' }
  | { kind: 'class'; role: 'student' | 'instructor' | 'any'; grant?: 'manage_members' }
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
  z.strictObject({ kind: z.literal('course'), role: z.enum(['editor', 'publisher', 'owner']) }),
]);

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A contract part that may be absent: `undefined` when the contract omits it. */
type Part = z.ZodType | undefined;
type InputOf<T extends Part> = T extends z.ZodType ? z.input<T> : never;

export interface RouteContract<
  P extends Part = Part,
  Q extends Part = Part,
  B extends Part = Part,
  R extends z.ZodType = z.ZodType,
  S extends Scope = Scope,
  X extends Part = Part,
> {
  method: Method;
  path: `/api/${string}`;
  scope: S;
  summary: string;
  /** Success status; defaults to 200. A 302 route answers with a redirect and no body. */
  status?: 200 | 202 | 302;
  params?: P;
  query?: Q;
  body?: B;
  response: R;
  /** Declared error bodies beyond the shared `{ error }` shape; today only 409 conflicts. */
  errors?: { 409: X };
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
  X extends Part = undefined,
>(c: RouteContract<P, Q, B, R, S, X>): RouteContract<P, Q, B, R, S, X> {
  return c;
}

export type ResponseOf<C> =
  C extends RouteContract<Part, Part, Part, infer R> ? z.output<R> : never;

/** Body of every refused request (401, 403, 404, 503): a short, non-identifying reason. */
export const errorBody = z.object({ error: z.string() });

/**
 * 409 body of an optimistic revision check (ADR-0003, §12 "never overwrite silently"): the
 * server's current copy, so an editor can show a conflict view instead of overwriting.
 */
export const conflictBody = <T extends z.ZodType>(current: T) =>
  z.object({ error: z.literal('revision_conflict'), current });

export type ConflictOf<C> =
  C extends RouteContract<Part, Part, Part, z.ZodType, Scope, infer X>
    ? X extends z.ZodType
      ? z.output<X>
      : never
    : never;

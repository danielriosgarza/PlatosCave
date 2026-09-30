import type { z } from 'zod';

export type Scope =
  | { kind: 'public' }
  | { kind: 'user' }
  | { kind: 'system' }
  | { kind: 'class'; role: 'student' | 'instructor' | 'any'; grant?: 'manage_members' }
  | { kind: 'course'; role: 'editor' | 'publisher' | 'owner' };

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
> {
  method: Method;
  path: `/api/${string}`;
  scope: S;
  summary: string;
  params?: P;
  query?: Q;
  body?: B;
  response: R;
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
>(c: RouteContract<P, Q, B, R, S>): RouteContract<P, Q, B, R, S> {
  return c;
}

export type ResponseOf<C> =
  C extends RouteContract<Part, Part, Part, infer R> ? z.output<R> : never;

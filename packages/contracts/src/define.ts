import type { z } from 'zod';

export type Scope =
  | { kind: 'public' }
  | { kind: 'user' }
  | { kind: 'system' }
  | { kind: 'class'; role: 'student' | 'instructor' | 'any'; grant?: 'manage_members' }
  | { kind: 'course'; role: 'editor' | 'publisher' | 'owner' };

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteContract<
  P extends z.ZodType = z.ZodType,
  Q extends z.ZodType = z.ZodType,
  B extends z.ZodType = z.ZodType,
  R extends z.ZodType = z.ZodType,
> {
  method: Method;
  path: `/api/${string}`;
  scope: Scope;
  summary: string;
  params?: P;
  query?: Q;
  body?: B;
  response: R;
  /** Valid example inputs; the isolation matrix (ADR-0002, P1-01) replays every contract with them. */
  examples: { params?: z.input<P>; query?: z.input<Q>; body?: z.input<B> };
}

export function defineRoute<
  P extends z.ZodType,
  Q extends z.ZodType,
  B extends z.ZodType,
  R extends z.ZodType,
>(c: RouteContract<P, Q, B, R>): RouteContract<P, Q, B, R> {
  return c;
}

export type ResponseOf<C> =
  C extends RouteContract<z.ZodType, z.ZodType, z.ZodType, infer R> ? z.output<R> : never;

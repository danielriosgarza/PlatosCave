/**
 * Result of a service mutation: the value, or why it was refused. Routes turn it into a
 * response with `settle` (http/register.ts): 404, 409 with the server copy, or 400.
 */
export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'conflict'; current: T }
  | { ok: false; reason: 'invalid'; message: string };

export const notFound = { ok: false, reason: 'not_found' } as const;
export const invalid = (message: string) => ({ ok: false, reason: 'invalid', message }) as const;

/**
 * Result of a service mutation: the value, or why it was refused. Routes turn it into a
 * response with `settle` (http/register.ts): 404, 409 with the server copy, 409
 * `class_archived` or `class_open`, or 400.
 */
export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'conflict'; current: T }
  | { ok: false; reason: 'invalid'; message: string }
  | { ok: false; reason: 'class_archived' }
  | { ok: false; reason: 'class_open' };

export const notFound = { ok: false, reason: 'not_found' } as const;
export const invalid = (message: string) => ({ ok: false, reason: 'invalid', message }) as const;
/** Archived classes keep read access and refuse writes (§4). */
export const classArchived = { ok: false, reason: 'class_archived' } as const;
/** An open class takes no post to the class or to instructors (§13, N10). */
export const classOpen = { ok: false, reason: 'class_open' } as const;

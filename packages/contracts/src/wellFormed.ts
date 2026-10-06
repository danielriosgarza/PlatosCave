/**
 * Text JSON can carry but Postgres's jsonb and the runner cannot take: a lone surrogate
 * (`"\ud800"`). A paired surrogate, such as an emoji, is one code point and is well-formed.
 * Node 22 has `String.prototype.isWellFormed`; the TypeScript lib target predates it.
 */
type WellFormedString = string & { isWellFormed(): boolean; toWellFormed(): string };

export const isWellFormed = (text: string): boolean => (text as WellFormedString).isWellFormed();

/**
 * Replaces each lone surrogate in a JSON value, object keys included, with U+FFFD so the value
 * can be stored. Anything without one comes back unchanged; nothing is dropped.
 */
export function toWellFormedDeep(value: unknown): unknown {
  if (typeof value === 'string') return (value as WellFormedString).toWellFormed();
  if (Array.isArray(value)) return value.map(toWellFormedDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [toWellFormedDeep(key), toWellFormedDeep(v)]),
    );
  }
  return value;
}

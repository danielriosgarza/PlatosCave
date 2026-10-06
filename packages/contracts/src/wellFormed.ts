/**
 * Text JSON can carry but Postgres's jsonb and the runner cannot take: a lone surrogate
 * (`"\ud800"`). A paired surrogate, such as an emoji, is one code point and is well-formed.
 * Node 22 has `String.prototype.isWellFormed`; the TypeScript lib target predates it.
 */
type WellFormedString = string & { isWellFormed(): boolean };

export const isWellFormed = (text: string): boolean => (text as WellFormedString).isWellFormed();

/** True when any string in a JSON value, object keys included, holds a lone surrogate. */
export function hasLoneSurrogate(value: unknown): boolean {
  if (typeof value === 'string') return !isWellFormed(value);
  if (Array.isArray(value)) return value.some(hasLoneSurrogate);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([key, v]) => !isWellFormed(key) || hasLoneSurrogate(v));
  }
  return false;
}

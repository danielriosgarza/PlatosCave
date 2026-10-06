/**
 * Text JSON can carry but Postgres's jsonb and the runner cannot take: a lone surrogate
 * (`"\ud800"`) and the NUL character (`"\u0000"`, SQLSTATE 22P05). A paired surrogate, such as an
 * emoji, is one code point and is well-formed.
 * Node 22 has `String.prototype.isWellFormed`; the TypeScript lib target predates it.
 */
type WellFormedString = string & { isWellFormed(): boolean; toWellFormed(): string };

export const isWellFormed = (text: string): boolean =>
  (text as WellFormedString).isWellFormed() && !text.includes('\u0000');

const wellFormedText = (text: string): string =>
  (text as WellFormedString).toWellFormed().replaceAll('\u0000', '\ufffd');

/**
 * Replaces each lone surrogate or NUL in a JSON value, object keys included, with U+FFFD so the value
 * can be stored. Anything without one comes back unchanged; nothing is dropped.
 */
export function toWellFormedDeep(value: unknown): unknown {
  if (typeof value === 'string') return wellFormedText(value);
  if (Array.isArray(value)) return value.map(toWellFormedDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [wellFormedText(key), toWellFormedDeep(v)]),
    );
  }
  return value;
}

/**
 * Whether `err` is Postgres's unique violation (23505) of `constraint`, raised directly by
 * node-postgres or wrapped by drizzle as the error's `cause`.
 */
export function uniqueViolation(err: unknown, constraint: string): boolean {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const { code, constraint: name } = e as { code?: unknown; constraint?: unknown };
    if (code === '23505') return name === constraint;
  }
  return false;
}

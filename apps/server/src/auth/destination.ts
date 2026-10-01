const BASE = 'http://parallax.invalid';

/**
 * The destination preserved through sign-in (§3), accepted only as a same-origin app path:
 * absolute URLs, scheme-relative `//host`, backslash tricks, control characters and API paths
 * are refused, so a sign-in link can never redirect off the app (no open redirect).
 */
export function safeDestination(input: unknown): string | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > 2048) return null;
  if (!input.startsWith('/') || input.startsWith('//')) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what we refuse
  if (/[\\\u0000-\u001f\u007f]/.test(input)) return null;
  let url: URL;
  try {
    url = new URL(input, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Where each entrance lands when no destination was preserved (§3: same page, explicit view). */
export function defaultDestination(entrance: 'student' | 'instructor' | undefined): string {
  return entrance === 'instructor' ? '/courses?view=instructor' : '/courses?view=student';
}

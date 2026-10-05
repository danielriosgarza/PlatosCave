/** Hosts a Shiny address may use over plain http, for development (§10.7). */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Why `content` is not a valid `shiny` revision (§10.7): it is `{ url }` where the address is
 * https, or http on a loopback host, and carries no credentials. Undefined when valid. The
 * server and the authoring form both ask this, so the form can refuse what the draft API would.
 */
export function shinyContentProblem(content: unknown): string | undefined {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    return 'shiny content must be an object with a url';
  }
  const { url } = content as { url?: unknown };
  if (typeof url !== 'string' || !url.trim()) return 'shiny content needs a url';
  return shinyAddressProblem(url);
}

/** Why a typed Shiny address cannot be used, or undefined when it can. */
export function shinyAddressProblem(address: string): string | undefined {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return 'The address is not a web address';
  }
  const local = url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !local) {
    return 'The address must start with https:// (http:// only for localhost)';
  }
  if (url.username || url.password) return 'The address must not contain a username or password';
  return undefined;
}

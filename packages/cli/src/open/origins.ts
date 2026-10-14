import { BuildStop } from './output';

/**
 * The host name of `origins.<name>` as hosts are compared: `URL` writes it in lower case and in
 * punycode, and normalises an IPv4 address; a trailing dot names the same host. A value without a
 * host name (no URL, or `mailto:`, `file:`) stops, named, as no origin.
 */
function hostOf(name: 'app' | 'content', origin: string): string {
  const host = URL.canParse(origin) ? new URL(origin).hostname.replace(/\.$/, '') : '';
  if (host) return host;
  throw new BuildStop(`origins.${name} (${origin}) is not an origin with a host name`);
}

/**
 * The host rule of a level 0 build (ADR-0002, amendment "Open site (level 0)"): the site and its
 * untrusted content are served from two host names. Hosts are compared through `URL`, without
 * scheme, port, path or a trailing dot, so `127.0.0.1` and `localhost` differ and two ports of one
 * host do not. The configuration schema refuses the same, and the build checks again.
 */
export function assertSeparateHosts({ app, content }: { app: string; content: string }): void {
  const host = hostOf('app', app);
  if (host !== hostOf('content', content)) return;
  throw new BuildStop(
    `origins.app (${app}) and origins.content (${content}) share the host name ${host}: a level 0 ` +
      'site serves untrusted content from a host name of its own, and another port, scheme or ' +
      'path does not make one. Give origins.content a host name of its own.',
  );
}

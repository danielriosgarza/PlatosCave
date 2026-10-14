import { BuildStop } from './output';

/** A host name as origins are compared: `URL` writes it in lower case and in punycode. */
const hostOf = (origin: string) =>
  URL.canParse(origin) ? new URL(origin).hostname.replace(/\.$/, '') : null;

/**
 * The host rule of a level 0 build (ADR-0002, amendment "Open site (level 0)"): the site and its
 * untrusted content are served from two host names. Hosts are compared in lower case, without
 * scheme, port or a trailing dot, so `127.0.0.1` and `localhost` differ and two ports of one host
 * do not. The configuration schema refuses the same, and the build checks again.
 */
export function assertSeparateHosts({ app, content }: { app: string; content: string }): void {
  const [site, objects] = [hostOf(app), hostOf(content)];
  if (site !== null && objects !== null && site !== objects) return;
  throw new BuildStop(
    `origins.app (${app}) and origins.content (${content}) must be two origins with different ` +
      'host names: a level 0 site serves untrusted content from a host of its own, and a port, ' +
      'a scheme or a path does not make one. Nothing was written.',
  );
}

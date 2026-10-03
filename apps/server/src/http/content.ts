import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import { type ContentClaims, verifyContentToken } from '../content/tokens';
import { type ByteRange, type Storage, StorageNotFoundError } from '../storage/storage';
import { NOT_FOUND } from './register';

/** The route pattern of the content origin; the only one the content host answers. */
export const CONTENT_ROUTE = '/content/:token';

/**
 * Untrusted bytes run with no script, no plugins, no forms and an opaque origin; they may only
 * load images, media, fonts and styles from the content origin itself.
 */
export function contentSecurityPolicy(contentOrigin: string): string {
  return [
    'sandbox',
    "default-src 'none'",
    `img-src ${contentOrigin} data:`,
    `media-src ${contentOrigin}`,
    `font-src ${contentOrigin} data:`,
    `style-src ${contentOrigin} 'unsafe-inline'`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** RFC 6266 header with an ASCII fallback and the exact UTF-8 name. */
export function contentDisposition(claims: ContentClaims): string {
  if (claims.disposition === 'inline' || !claims.filename) return claims.disposition;
  const ascii = claims.filename.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  // RFC 8187 ext-value: encodeURIComponent leaves !'()* unescaped, which are not attr-chars.
  const encoded = encodeURIComponent(claims.filename).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * The one byte range a `Range` header asks for, clamped to an object of `size` bytes: `null`
 * when the header is absent or not a single `bytes=` range (served whole, as RFC 9110 allows),
 * `'unsatisfiable'` when it lies past the end.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | null | 'unsatisfiable' {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!match) return null;
  const [, first, last] = match;
  if (first === '' && last === '') return null;
  if (first === '') {
    // A suffix: the last `last` bytes.
    const length = Number(last);
    if (length === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return 'unsatisfiable';
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  return end < start ? null : { start, end };
}

export interface ContentOriginDeps {
  config: Config;
  storage: Storage;
  now: () => Date;
}

/** `host` or `host:port` (also `[v6]:port`) and nothing else: no userinfo, path or spaces. */
const HOST_HEADER = /^([^\s:/?#@[\]]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/**
 * Compares the raw `Host` header, not `req.hostname`: under TRUST_PROXY Fastify takes the latter
 * from `X-Forwarded-Host`, which would make this split depend on the proxy stripping client
 * copies of that header. The app/content origin split must hold whatever the proxy does, so it
 * reads what the browser sent (a browser never sends `X-Forwarded-Host`; the proxy must still
 * forward `Host` unchanged, as .env.example asks).
 */
export const isContentHost = (req: FastifyRequest, config: Config): boolean =>
  (HOST_HEADER.exec(req.headers.host ?? '')?.[1] ?? '').toLowerCase() === config.CONTENT_HOST;

/**
 * The content origin (ADR-0002, §13): on CONTENT_HOST the server answers `/content/:token` and
 * nothing else (no API, no web app); on any other host `/content/*` does not exist. Tokens are
 * the only credential: cookies are never read, so an untrusted page cannot ride the app session.
 */
export function registerContentOrigin(app: FastifyInstance, deps: ContentOriginDeps): void {
  const { config, storage, now } = deps;

  // Decided on the route the router actually matched (set before onRequest), not on the URL's
  // spelling, so encoded or doubled slashes cannot steer a request past this check. On the content
  // host only the content route answers: API routes and unmatched paths (the SPA fallback) are
  // 404; on any other host the content route does not exist.
  app.addHook('onRequest', async (req, reply) => {
    const isContentRoute = req.routeOptions.url === CONTENT_ROUTE;
    if (isContentHost(req, config) !== isContentRoute) return reply.code(404).send(NOT_FOUND);
    if (isContentRoute) {
      // The app reads content bytes in script (fonts; PDFs, which the reader renders with pdf.js
      // rather than framing them: the sandbox CSP blocks the browser's PDF viewer). Only the exact
      // app origin may, without credentials. Set here so refusals (an expired token's 404) and
      // errors are readable too, and the reader can tell "expired" from "unreachable".
      reply
        .header('access-control-allow-origin', config.APP_ORIGIN)
        .header('vary', 'origin')
        // pdf.js reads ranges and needs their headers to do so.
        .header('access-control-expose-headers', 'content-range, accept-ranges, content-length');
    }
  });

  // pdf.js asks for byte ranges, and a `Range: bytes=a-b` header makes the browser send a
  // preflight. The answer allows the app origin to read with that one header and nothing else;
  // it names no token's validity, so it tells a caller nothing the GET does not.
  app.options(CONTENT_ROUTE, { schema: { hide: true } }, async (_req, reply) =>
    reply
      .code(204)
      .header('access-control-allow-methods', 'GET, HEAD')
      .header('access-control-allow-headers', 'range')
      .header('access-control-max-age', '600')
      .send(),
  );

  // Not part of the API: kept out of the OpenAPI document.
  app.get<{ Params: { token: string } }>(
    CONTENT_ROUTE,
    {
      schema: { hide: true },
      // The app origin can read this route's responses in script; a server error, including a
      // body stream that fails before its headers flush, is answered by the server-wide handler
      // (http/errors.ts) without the storage error's text or the object's headers.
    },
    async (req, reply) => {
      // Defence in depth: the onRequest hook already refuses other hosts.
      if (!isContentHost(req, config)) return reply.code(404).send(NOT_FOUND);
      const claims = verifyContentToken(config.CONTENT_TOKEN_SECRET, req.params.token, now());
      if (!claims) return reply.code(404).send(NOT_FOUND);
      // One backend call per request: HEAD needs only the size, GET streams body and size. A
      // ranged GET first asks for the size, to know which bytes the range means.
      let object: { body?: Readable; size: number } | null;
      let range: ByteRange | null = null;
      try {
        if (req.method === 'HEAD') object = await storage.head(claims.key);
        else if (req.headers.range) {
          const whole = await storage.head(claims.key);
          const asked = whole && parseRange(req.headers.range, whole.size);
          if (asked === 'unsatisfiable') {
            return reply
              .code(416)
              .header('content-range', `bytes */${whole?.size}`)
              .send(NOT_FOUND);
          }
          range = asked || null;
          object = whole && (await storage.get(claims.key, range ?? undefined));
        } else object = await storage.get(claims.key);
      } catch (err) {
        if (!(err instanceof StorageNotFoundError)) throw err;
        object = null;
      }
      if (!object) return reply.code(404).send(NOT_FOUND);

      if (range) reply.header('content-range', `bytes ${range.start}-${range.end}/${object.size}`);
      const maxAge = Math.max(0, claims.exp - Math.ceil(now().getTime() / 1000));
      return (
        reply
          .code(range ? 206 : 200)
          .header('accept-ranges', 'bytes')
          .header('content-type', claims.contentType)
          .header('content-length', range ? range.end - range.start + 1 : object.size)
          .header('content-disposition', contentDisposition(claims))
          .header('content-security-policy', contentSecurityPolicy(config.CONTENT_ORIGIN))
          .header('x-content-type-options', 'nosniff')
          // The app origin embeds these objects (<img>, <video>, fonts): allow cross-origin reads.
          .header('cross-origin-resource-policy', 'cross-origin')
          .header('referrer-policy', 'no-referrer')
          .header('cache-control', `private, max-age=${maxAge}`)
          // The app origin's helmet baseline forbids framing; the app frames content documents
          // (readings, PDFs), whose own CSP above already sandboxes them.
          .removeHeader('x-frame-options')
          .send(object.body)
      );
    },
  );
}

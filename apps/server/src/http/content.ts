import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import { type ContentClaims, verifyContentToken } from '../content/tokens';
import { type Storage, StorageNotFoundError } from '../storage/storage';
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

export interface ContentOriginDeps {
  config: Config;
  storage: Storage;
  now: () => Date;
}

/** The content route's 5xx body: storage errors name endpoints and buckets, and the app reads it. */
export const INTERNAL_ERROR = { error: 'internal error' } as const;

export const isContentHost = (req: FastifyRequest, config: Config): boolean =>
  (req.hostname ?? '').toLowerCase() === config.CONTENT_HOST;

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
      reply.header('access-control-allow-origin', config.APP_ORIGIN).header('vary', 'origin');
    }
  });

  // Not part of the API: kept out of the OpenAPI document.
  app.get<{ Params: { token: string } }>(
    CONTENT_ROUTE,
    {
      schema: { hide: true },
      // The app origin can read this route's responses in script, so a server error must not
      // carry the storage error's text. The real error is logged; 4xx go to the default handler.
      errorHandler: (err, req, reply) => {
        const status = (err as { statusCode?: number }).statusCode ?? 500;
        if (status < 500) throw err;
        req.log.error({ err }, 'content request failed');
        return reply.code(500).send(INTERNAL_ERROR);
      },
    },
    async (req, reply) => {
      // Defence in depth: the onRequest hook already refuses other hosts.
      if (!isContentHost(req, config)) return reply.code(404).send(NOT_FOUND);
      const claims = verifyContentToken(config.CONTENT_TOKEN_SECRET, req.params.token, now());
      if (!claims) return reply.code(404).send(NOT_FOUND);
      // One backend call per request: HEAD needs only the size, GET streams body and size.
      let object: { body?: Readable; size: number } | null;
      try {
        object =
          req.method === 'HEAD' ? await storage.head(claims.key) : await storage.get(claims.key);
      } catch (err) {
        if (!(err instanceof StorageNotFoundError)) throw err;
        object = null;
      }
      if (!object) return reply.code(404).send(NOT_FOUND);

      const maxAge = Math.max(0, claims.exp - Math.ceil(now().getTime() / 1000));
      return (
        reply
          .header('content-type', claims.contentType)
          .header('content-length', object.size)
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

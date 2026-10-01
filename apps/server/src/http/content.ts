import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import { type ContentClaims, verifyContentToken } from '../content/tokens';
import { type Storage, StorageNotFoundError } from '../storage/storage';

const NOT_FOUND = { error: 'not found' };
/** The one path the content host serves: a single token segment. */
const TOKEN_PATH = /^\/content\/[^/]+$/;
const CONTENT_PREFIX = /^\/content(\/|$)/;

/**
 * The path the router will see. The router strips scheme and host from an absolute-form target
 * (`GET http://x/content/… HTTP/1.1`), so the raw URL must not be tested as if it were a path.
 */
const pathOf = (url: string): string => new URL(url, 'http://invalid').pathname;

/** Request URL with any content token replaced, so credentials never reach the logs. */
export const redactContentUrl = (url: string): string =>
  url.replace(/\/content\/[^/?#]+/g, '/content/[redacted]');

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

const isContentHost = (req: FastifyRequest, config: Config) =>
  (req.hostname ?? '').toLowerCase() === config.CONTENT_HOST;

/**
 * The content origin (ADR-0002, §13): on CONTENT_HOST the server answers `/content/:token` and
 * nothing else (no API, no web app); on any other host `/content/*` does not exist. Tokens are
 * the only credential: cookies are never read, so an untrusted page cannot ride the app session.
 */
export function registerContentOrigin(app: FastifyInstance, deps: ContentOriginDeps): void {
  const { config, storage, now } = deps;

  // On the content host anything but `/content/<token>` is 404 here, before routing, so neither
  // the API nor the SPA fallback can answer there; on other hosts `/content…` does not exist.
  app.addHook('onRequest', async (req, reply) => {
    const path = pathOf(req.url);
    const allowed = isContentHost(req, config) ? TOKEN_PATH.test(path) : !CONTENT_PREFIX.test(path);
    if (!allowed) return reply.code(404).send(NOT_FOUND);
  });

  // Not part of the API: kept out of the OpenAPI document.
  app.get<{ Params: { token: string } }>(
    '/content/:token',
    { schema: { hide: true } },
    async (req, reply) => {
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
          .send(object.body)
      );
    },
  );
}

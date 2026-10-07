import { createHash } from 'node:crypto';
import type { StoredNotebookOutput } from '@parallax/contracts';
import {
  MAX_LIVE_OUTPUT_BYTES,
  renderLiveOutput,
} from '@parallax/contracts/routes/notebookSessions';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import { mintContentUrl } from '../../content/media';
import { renderLiveOutputInThread } from '../../content/notebook-render';
import { ThreadInputError } from '../../content/thread';
import { findSession } from '../../db/notebooks/sessions';
import { classLiveOutputPrefix } from '../../storage/storage';
import { WindowLimit } from '../budgets';
import { notFound, registerRoute } from '../register';
import { outputView } from '../routes/notebooks.routes';

/** New bytes one session may store as live output objects, in this process (the only relay). */
export const MAX_SESSION_LIVE_BYTES = 100 * 1024 * 1024;
/** Sessions and rendered outputs remembered; the oldest are forgotten first. */
const MAX_REMEMBERED = 2000;

interface Rendered {
  output: StoredNotebookOutput;
  /** Content type of each object the output names, by key. */
  types: Record<string, string>;
}

/** Sets `key` last in insertion order and drops the oldest entries beyond `MAX_REMEMBERED`. */
function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  for (const oldest of map.keys()) {
    if (map.size <= MAX_REMEMBERED) break;
    map.delete(oldest);
  }
}

/**
 * Live notebook output on the content origin (docs/design/connector.md §14, spec §10.4, ADR-0002):
 * one rich output of the caller's own session is rendered by the stored-output code in a bounded
 * thread, its frame document or image is written under the session's area of class storage, and
 * the answer carries five-minute links minted for the caller. The browser asks again whenever it
 * shows the output, so a link is never older than the view. Served in `relay` mode with the
 * other session routes; the session is read through the caller's class scope, so anyone else's
 * is the shared 404 (A33).
 */
export default function liveOutputRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const db = deps.requireDb;
  const { now, config, storage } = deps;
  // An output shown again (a re-opened cell, a link renewed) is answered without a new render.
  const rendered = new Map<string, Rendered>();
  const storedBytes = new Map<string, number>();
  const asked = new WindowLimit({ max: 120, windowMs: 60_000 });

  registerRoute(
    app,
    renderLiveOutput,
    async ({ scope, params, body, fail }) => {
      const session = await findSession(db(), scope, params.sessionId);
      if (!session) return notFound();
      const at = now();
      if (!asked.take(scope.user.id, at)) return fail(429, { error: 'too many requests' });

      const prefix = classLiveOutputPrefix(scope.classId, session.id);
      const id = `${session.id}:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`;
      let result = rendered.get(id);
      if (!result) {
        let live: Awaited<ReturnType<typeof renderLiveOutputInThread>>;
        try {
          live = await renderLiveOutputInThread(body, prefix);
        } catch (err) {
          if (err instanceof ThreadInputError) {
            return fail(422, { error: 'not_rendered', message: err.message });
          }
          throw err;
        }
        const missing: typeof live.objects = [];
        for (const object of live.objects) {
          if (!(await storage.head(object.key))) missing.push(object);
        }
        const adding = missing.reduce((sum, o) => sum + o.bytes.byteLength, 0);
        const before = storedBytes.get(session.id) ?? 0;
        if (adding > 0 && before + adding > MAX_SESSION_LIVE_BYTES) {
          return fail(409, { error: 'storage_limit' });
        }
        for (const object of missing) {
          const stored = await storage.put(prefix, object.bytes);
          // Keys are content addresses: the render named the object as storage does.
          if (stored.key !== object.key) throw new Error('live output key mismatch');
        }
        if (adding > 0) remember(storedBytes, session.id, before + adding);
        result = {
          output: live.output,
          types: Object.fromEntries(live.objects.map((o) => [o.key, o.contentType])),
        };
        // Only outputs with links are asked for again; text, tables and Markdown are not.
        if (live.objects.length > 0) remember(rendered, id, result);
      }

      const { types } = result;
      let expiresAt: string | null = null;
      const urlFor = (key: string) => {
        const contentType = types[key];
        if (!contentType) return null;
        const minted = mintContentUrl(
          { contentOrigin: config.CONTENT_ORIGIN, secret: config.CONTENT_TOKEN_SECRET, now: at },
          scope,
          { key, contentType },
          { disposition: 'inline' },
        );
        expiresAt = minted.expiresAt;
        return minted.url;
      };
      return { output: outputView(result.output, urlFor), expiresAt };
    },
    { bodyLimit: MAX_LIVE_OUTPUT_BYTES + 64 * 1024 },
  );
}

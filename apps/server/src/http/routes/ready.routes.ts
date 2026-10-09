import { ready } from '@parallax/contracts/routes/ready';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import { PROBE_TIMEOUT_MS, probe } from '../../db/client';
import { VERSION } from '../../version';
import { probeLimit } from '../probe';
import { registerRoute } from '../register';

type Check = { status: 'ok' | 'unavailable' | 'skipped'; required: boolean; latencyMs: number };

/** Probed when the store has no `ping`: a safe key no upload uses, so the answer is `null`. */
const STORAGE_PROBE_KEY = 'readiness/probe';

/** Runs `check` with a deadline and reports only whether it answered, never why it did not. */
async function timed(
  required: boolean,
  timeoutMs: number,
  check: (() => Promise<unknown>) | undefined,
  onFailure: (err: unknown) => void,
): Promise<Check> {
  if (!check) return { status: 'skipped', required, latencyMs: 0 };
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
  });
  let status: Check['status'] = 'ok';
  try {
    await Promise.race([check(), deadline]);
  } catch (err) {
    onFailure(err);
    status = 'unavailable';
  } finally {
    clearTimeout(timer);
  }
  return { status, required, latencyMs: Math.round(performance.now() - started) };
}

export default function readyRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { rateLimit, isProbeRequest } = probeLimit(
    deps.config.READY_PROBE_TOKEN,
    deps.config.READY_RATE_LIMIT,
  );
  const timeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const { db, storage } = deps;

  registerRoute(
    app,
    ready,
    async ({ fail, req }) => {
      const failed = (name: string) => (err: unknown) =>
        app.log.warn({ err, dependency: name }, 'readiness: dependency unavailable');
      const [database, store] = await Promise.all([
        timed(true, timeoutMs, db && (() => probe(db, timeoutMs)), failed('database')),
        timed(
          true,
          timeoutMs,
          () => (storage.ping ? storage.ping() : storage.head(STORAGE_PROBE_KEY)),
          failed('storage'),
        ),
      ]);
      // pg-boss runs its statements on the application's pool and exists only when it started
      // against the database (main.ts), so a queue is as ready as the database plus its presence;
      // one probe answers for all three rather than a pool connection each.
      const viaDatabase = (present: boolean, required: boolean): Check =>
        !present || database.status === 'skipped'
          ? { status: 'skipped', required, latencyMs: 0 }
          : { ...database, required };
      const checks = {
        database,
        queue: viaDatabase(deps.boss !== undefined, true),
        executionQueue: viaDatabase(deps.bossExec !== undefined, false),
        storage: store,
      };
      const isReady = Object.values(checks).every((c) => !c.required || c.status === 'ok');
      const status = isReady ? ('ready' as const) : ('not_ready' as const);
      // Anyone but a probe learns only whether the instance is ready (ADR-0002).
      const body = isProbeRequest(req)
        ? {
            status,
            version: VERSION,
            mode: deps.mode === 'relay' ? ('relay' as const) : ('api' as const),
            checks,
          }
        : { status };
      return isReady ? body : fail(503, body);
    },
    // Every answer runs a database query and a storage call, so callers without the probe
    // token are limited per address; probes are not counted, so a health check never trips it.
    { rateLimit },
  );
}

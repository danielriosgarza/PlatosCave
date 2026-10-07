import { ready } from '@parallax/contracts/routes/ready';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import { PROBE_TIMEOUT_MS, probe } from '../../db/client';
import { registerRoute } from '../register';

type Check = { status: 'ok' | 'unavailable' | 'skipped'; required: boolean; latencyMs: number };

/** The storage key probed: a safe key no upload ever uses, so the answer is `null`, not data. */
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
  const timeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const { db, storage } = deps;

  registerRoute(app, ready, async ({ fail }) => {
    const failed = (name: string) => (err: unknown) =>
      app.log.warn({ err, dependency: name }, 'readiness: dependency unavailable');
    const [database, queue, executionQueue, store] = await Promise.all([
      timed(true, timeoutMs, db && (() => probe(db, timeoutMs)), failed('database')),
      // A queue exists only when pg-boss started against the database (main.ts); a failed start
      // leaves it out, so its presence is the check, and the database probe covers its link.
      timed(true, timeoutMs, db && deps.boss && (() => probe(db, timeoutMs)), failed('queue')),
      timed(
        false,
        timeoutMs,
        db && deps.bossExec && (() => probe(db, timeoutMs)),
        failed('executionQueue'),
      ),
      timed(true, timeoutMs, () => storage.head(STORAGE_PROBE_KEY), failed('storage')),
    ]);
    const checks = { database, queue, executionQueue, storage: store };
    const isReady = Object.values(checks).every((c) => !c.required || c.status === 'ok');
    const body = {
      status: isReady ? ('ready' as const) : ('not_ready' as const),
      version: '0.0.0',
      mode: deps.mode === 'relay' ? ('relay' as const) : ('api' as const),
      checks,
    };
    return isReady ? body : fail(503, body);
  });
}

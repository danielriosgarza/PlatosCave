import type { PgBoss } from 'pg-boss';
import type { CourseScope } from '../auth/scope';
import type { Db } from '../db/client';
import {
  type ValidateOptions,
  type ValidationReport,
  validateDrafts,
} from '../db/content/releases';
import { type FolderRelease, publishFolderRelease } from '../db/content/sync';
import { listResourceJobStatus } from '../db/jobs/derived';
import {
  enqueueIfUnprocessed,
  enqueueReadingIngest,
  isProcessed,
} from '../jobs/reading-ingest.job';

/**
 * Steps 7 and 8 of `parallax sync` (docs/design/course-folder.md §10): conversion, the wait for
 * the worker, and publication under the fingerprint step 6 took. It builds no query; the data
 * access is the job modules' and `db/content/sync.ts`'s.
 */

/**
 * The bounds of the wait: it ends when nothing has changed for `idleMs` while no head is running
 * (no worker took the jobs), or after `limitMs`; `pollMs` is the time between two reads.
 */
export const WAIT = { idleMs: 60_000, limitMs: 30 * 60_000, pollMs: 1_000 };

export interface PublishDeps {
  db: Db;
  /** A queue in the API role, with the queue of `reading.ingest` created. */
  boss: PgBoss;
  /** The server's `SHINY_ORIGINS` and `RUNNER_RUNTIMES`, as the publish route passes them. */
  validate: ValidateOptions;
  wait?: Partial<typeof WAIT>;
}

export type PublishOutcome =
  | FolderRelease
  /** Not finished and safe to run again: the queued jobs stay queued for a later worker. */
  | { status: 'unfinished'; reason: 'idle' | 'limit'; report: ValidationReport };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The live heads of a type the worker processes, with their job status. */
const processedHeads = async (db: Db, scope: CourseScope) =>
  (await listResourceJobStatus(db, scope)).filter((h) => h.revisionId && isProcessed(h.type));

/**
 * Queues each head of a processed type that has no status, as the draft routes do, and each
 * failed one again, as the retry route does; waits until every head is ready or failed; then
 * publishes with `publishFolderRelease`. A failed conversion is not handled here: publication
 * blocks on it with its own report. When the wait ends at a bound nothing is published, and the
 * report of `validateDrafts` names each head still being processed.
 */
export async function convertAndPublish(
  deps: PublishDeps,
  scope: CourseScope,
  fingerprint: string,
): Promise<PublishOutcome> {
  const { db, boss } = deps;
  const { idleMs, limitMs, pollMs } = { ...WAIT, ...deps.wait };
  for (const head of await processedHeads(db, scope)) {
    if (!head.revisionId) continue;
    if (!head.status) await enqueueIfUnprocessed(boss, db, scope, head.revisionId);
    else if (head.status.state === 'failed') {
      await enqueueReadingIngest(boss, db, scope, head.revisionId, { tag: head.statusTag });
    }
  }
  const start = Date.now();
  let seen = '';
  let since = start;
  for (;;) {
    const heads = await processedHeads(db, scope);
    const states = heads.map((h) => h.status?.state);
    if (states.every((s) => s === 'ready' || s === 'failed')) break;
    const now = Date.now();
    const current = JSON.stringify(heads.map((h) => [h.revisionId, h.status?.state]));
    if (current !== seen || states.includes('running')) [seen, since] = [current, now];
    const reason = now - since >= idleMs ? 'idle' : now - start >= limitMs ? 'limit' : undefined;
    if (reason) {
      return {
        status: 'unfinished',
        reason,
        report: await validateDrafts(db, scope, deps.validate),
      };
    }
    await sleep(pollMs);
  }
  return publishFolderRelease(db, scope, fingerprint, deps.validate);
}

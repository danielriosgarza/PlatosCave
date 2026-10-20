import { pathToFileURL } from 'node:url';
import { isWellFormed, siteIssueLines } from '@parallax/contracts';
import { ZodError } from 'zod';
import { type Config, loadConfig } from '../config';
import { readBundle } from '../content/folder-bundle';
import { type SyncResult, syncCourse } from '../content/folder-sync';
import { withSyncDatabase } from '../db/content/sync';
import { loadJobs } from '../jobs/registry';
import { ensureQueues } from '../jobs/scoped';
import { createStorage } from '../storage/create';

/** A line for the terminal, its control, format and separator characters as code points. */
const shown = (line: string) =>
  line.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, (char) => `\\u{${char.codePointAt(0)?.toString(16)}}`);

/** The error's code or kind, as `apply` names one: a failed query's message holds the address. */
function stopLine(err: unknown): string {
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
  const code = (cause as { code?: unknown } | null)?.code;
  const kind = typeof code === 'string' ? code : cause instanceof Error ? cause.name : typeof cause;
  return `sync stopped by an error: ${kind}; no release was published, and sync is safe to run again`;
}

/**
 * The server side of `parallax sync` (docs/design/course-folder.md §10), run as `docker compose
 * run --rm -T server node_modules/.bin/tsx src/scripts/sync-course.ts` with one course's bundle on
 * standard input, so no address is on a command line, in the service's environment. Exit codes:
 * 0 published or nothing to publish, 1 refused or blocked, 2 a malformed bundle or environment,
 * before the database is opened, 3 not finished and safe to run again, as after a thrown error.
 */
export async function syncFromBundle(
  input: AsyncIterable<Uint8Array>,
  env: NodeJS.ProcessEnv,
  print: (line: string) => void,
  warn: (line: string) => void,
): Promise<SyncResult['code']> {
  // What was done so far, which an error that ends the run keeps ("created course").
  const report: string[] = [];
  try {
    const bundle = await readBundle(input);
    if ('problems' in bundle) {
      for (const line of bundle.problems) warn(shown(`malformed bundle: ${line}`));
      return 2;
    }
    // `createCourse` stores the title, which no rule of `planSync` sees.
    if (!isWellFormed(bundle.header.manifest.title)) {
      print('course.yaml: title: The text holds a NUL or an unpaired surrogate');
      return 1;
    }
    let config: Config;
    try {
      config = loadConfig(env);
    } catch (err) {
      if (!(err instanceof ZodError)) throw err;
      // An environment the server would not start with: its fields, never its values.
      for (const line of siteIssueLines(err.issues)) warn(`the server's environment: ${line}`);
      return 2;
    }
    const { DATABASE_URL: url, SHINY_ORIGINS, RUNNER_RUNTIMES, INSTRUCTOR_EMAILS } = config;
    if (!url) {
      warn('DATABASE_URL is required');
      return 2;
    }
    const storage = createStorage(config);
    const validate = { approvedShinyOrigins: SHINY_ORIGINS, runtimes: RUNNER_RUNTIMES };
    // Settled when the run ends, so the script exits without waiting for the queue and the pool
    // to close. Their errors reach the run as the error of the call that meets them.
    const result = await new Promise<SyncResult>((resolve, reject) => {
      withSyncDatabase(url, { onError() {}, onWarning() {} }, async (db, boss) => {
        const run = async () => {
          // As the API at start-up (main.ts:96): a send to a missing queue throws.
          await ensureQueues(boss, await loadJobs());
          const deps = { db, boss, storage, validate, instructorEmails: INSTRUCTOR_EMAILS };
          return syncCourse(deps, bundle.header, bundle.files, report);
        };
        await run().then(resolve, reject);
      }).catch(reject);
    });
    for (const line of result.report) print(shown(line));
    return result.code;
  } catch (err) {
    for (const line of report) print(shown(line));
    warn(stopLine(err));
    return 3;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  syncFromBundle(process.stdin, process.env, console.log, console.error).then(process.exit);
}

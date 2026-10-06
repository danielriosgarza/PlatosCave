import pino from 'pino';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { createBoss, EXEC_SCHEMA } from './db/jobs/boss';
import { workExecution } from './execution/handlers';
import { ensureExecQueues } from './execution/queues';
import type { JobLogger } from './jobs/logger';
import { retentionPolicy, workMaintenance } from './jobs/maintenance';
import { loadJobs } from './jobs/registry';
import { ensureQueues, workScopedJob } from './jobs/scoped';
import { createStorage } from './storage/create';
import type { Storage } from './storage/storage';

/**
 * `api` serves the HTTP API; `relay` serves the same and the routes that need a live connector
 * link (docs/design/connector.md §10.1). The link registry is in memory, so a deployment runs
 * exactly one `relay` process; `worker` runs the background jobs.
 */
const mode = process.argv[2] ?? 'api';
if (mode !== 'api' && mode !== 'relay' && mode !== 'worker') {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}

/**
 * Active jobs get this long to finish on SIGTERM before pg-boss fails them for retry. It stays
 * below the 10 s stop grace period of Docker Compose and Kubernetes, which a worker deployment
 * must keep at 10 s or more, so the worker exits before it is killed.
 */
const WORKER_STOP_TIMEOUT_MS = 8_000;

// Both modes read one environment (the worker also requires the API's secrets in production), so
// API and worker deploy from the same configuration and a worker can mint content URLs later.
const config = loadConfig();
// The pool is created before the logger that reports its errors; until then they go to stderr.
let logPoolError = (err: Error) => console.error('pg pool error', err);
const database = config.DATABASE_URL
  ? createDb(config.DATABASE_URL, { onError: (err) => logPoolError(err) })
  : undefined;

/** Whether the promise settles (resolves or rejects) within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const settled = promise.then(
    () => true,
    () => true,
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Closes in order and exits; a second signal forces exit if closing hangs. */
function onSignals(log: JobLogger, close: () => Promise<unknown>): void {
  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1);
    stopping = true;
    close()
      .then(() => database?.pool.end())
      .then(
        () => process.exit(0),
        (err) => {
          log.error({ err }, 'shutdown failed');
          process.exit(1);
        },
      );
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (mode === 'api' || mode === 'relay') {
  // The API only sends jobs (adoption queues annotation mapping); workers run them.
  let logBossError = (err: Error) => console.error('pg-boss error', err);
  let logBossWarning = (warning: object) => console.warn('pg-boss warning', warning);
  const boss =
    database &&
    createBoss(database.pool, {
      role: 'api',
      onError: (err) => logBossError(err),
      onWarning: (warning) => logBossWarning(warning),
    });
  // Without a queue the API still serves; adoptions then queue no mapping (logged at error).
  // pg-boss refuses sends to a missing queue, so every discovered job's queue exists before a
  // route sends one (an adoption, a reading upload), created once here rather than on every
  // send. The worker discovers the same files.
  const started = await boss
    ?.start()
    .then(async () => ensureQueues(boss, await loadJobs()))
    .then(
      () => true,
      (err) => {
        logBossError(err);
        return false;
      },
    );
  // The runner's channel (docs/design/runner.md §8.4): a second instance on schema pgboss_exec.
  // Without it the API still serves; code runs answer 503 and submissions queue no grading.
  const bossExec =
    database &&
    createBoss(database.pool, {
      role: 'api',
      schema: EXEC_SCHEMA,
      onError: (err) => logBossError(err),
      onWarning: (warning) => logBossWarning(warning),
    });
  const execStarted = await bossExec
    ?.start()
    .then(() => ensureExecQueues(bossExec))
    .then(
      () => true,
      (err) => {
        logBossError(err);
        return false;
      },
    );
  const app = await buildApp(config, {
    mode,
    ...(database && {
      db: database.db,
      ...(started && { boss }),
      ...(execStarted && { bossExec }),
    }),
  });
  logPoolError = (err) => app.log.error({ err }, 'pg pool error');
  logBossError = (err) => app.log.error({ err }, 'pg-boss error');
  logBossWarning = (warning) => app.log.warn({ warning }, 'pg-boss warning');
  await app.listen({ port: config.PORT, host: config.HOST });
  onSignals(app.log, async () => {
    await app.close();
    await boss?.stop({ graceful: true });
    await bossExec?.stop({ graceful: true });
  });
} else {
  const log = pino({ level: config.LOG_LEVEL, name: 'worker' });
  logPoolError = (err) => log.error({ err }, 'pg pool error');
  if (!database) {
    log.fatal('worker mode needs DATABASE_URL');
    process.exit(2);
  }
  const boss = createBoss(database.pool, {
    role: 'worker',
    schedule: true,
    onError: (err) => log.error({ err }, 'pg-boss error'),
    onWarning: (warning) => log.warn({ warning }, 'pg-boss warning'),
  });
  // The runner's channel: this worker supervises pgboss_exec, so it expires the `active` job of
  // a runner that died mid-run (design §7.5), and consumes results and dead letters.
  const bossExec = createBoss(database.pool, {
    role: 'worker',
    schema: EXEC_SCHEMA,
    onError: (err) => log.error({ err }, 'pg-boss error'),
    onWarning: (warning) => log.warn({ warning }, 'pg-boss warning'),
  });
  let storage: Storage | undefined;
  const started = (async () => {
    // Inside startup, so a store that cannot be set up is reported as a failed start.
    storage = createStorage(config);
    await boss.start();
    await bossExec.start();
    await ensureExecQueues(bossExec);
    const exec = { boss: bossExec, runtimes: config.RUNNER_RUNTIMES, log };
    const jobs = await loadJobs();
    // Jobs get the queue too, so one may queue follow-ups (ingestion re-queues mapping).
    for (const job of jobs) {
      await workScopedJob(boss, database.db, job, log, {}, { storage, boss, exec });
    }
    const maintenance = await workMaintenance(boss, database.db, log, retentionPolicy(config));
    const execution = await workExecution(bossExec, database.db, log);
    log.info(
      { jobs: [...jobs.map((j) => j.name), ...maintenance, ...execution] },
      'worker started',
    );
  })();
  // Installed before startup, so a signal during it still stops pg-boss once startup settles.
  // pg-boss's own stop() waits for start() too, so a startup that hangs (boss.start() waiting on
  // the database) is raced against the budget: past it the worker exits 1 without stopping.
  onSignals(log, async () => {
    const deadline = Date.now() + WORKER_STOP_TIMEOUT_MS;
    if (!(await settlesWithin(started, WORKER_STOP_TIMEOUT_MS))) {
      throw new Error(`worker startup did not settle within ${WORKER_STOP_TIMEOUT_MS} ms`);
    }
    await Promise.all(
      [boss, bossExec].map((b) =>
        b.stop({ graceful: true, timeout: Math.max(deadline - Date.now(), 1) }),
      ),
    );
    storage?.destroy?.();
  });
  try {
    await started;
  } catch (err) {
    log.fatal({ err }, 'worker failed to start');
    process.exit(1);
  }
}

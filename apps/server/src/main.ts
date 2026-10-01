import pino from 'pino';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { createBoss } from './jobs/boss';
import { workMaintenance } from './jobs/maintenance';
import { loadJobs } from './jobs/registry';
import { workScopedJob } from './jobs/scoped';
import { createStorage } from './storage/create';

const mode = process.argv[2] ?? 'api';
if (mode !== 'api' && mode !== 'worker') {
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

/** Closes in order and exits; a second signal forces exit if closing hangs. */
function onSignals(
  log: { error: (obj: object, msg: string) => void },
  close: () => Promise<unknown>,
): void {
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

if (mode === 'api') {
  const app = await buildApp(config, database ? { db: database.db } : {});
  logPoolError = (err) => app.log.error({ err }, 'pg pool error');
  await app.listen({ port: config.PORT, host: config.HOST });
  onSignals(app.log, () => app.close());
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
  const storage = createStorage(config);
  const started = (async () => {
    await boss.start();
    const jobs = await loadJobs();
    for (const job of jobs) await workScopedJob(boss, database.db, job, log, {}, { storage });
    const maintenance = await workMaintenance(boss, database.db, log);
    log.info({ jobs: [...jobs.map((j) => j.name), ...maintenance] }, 'worker started');
  })();
  // Installed before startup, so a signal during it still stops pg-boss once startup settles.
  onSignals(log, async () => {
    await started.catch(() => {});
    await boss.stop({ graceful: true, timeout: WORKER_STOP_TIMEOUT_MS });
    storage.destroy?.();
  });
  try {
    await started;
  } catch (err) {
    log.fatal({ err }, 'worker failed to start');
    process.exit(1);
  }
}

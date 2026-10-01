import pino from 'pino';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { createBoss } from './jobs/boss';
import { loadJobs } from './jobs/registry';
import { workScopedJob } from './jobs/scoped';

const mode = process.argv[2] ?? 'api';
if (mode !== 'api' && mode !== 'worker') {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}

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
  // The API only sends jobs (adoption queues annotation mapping); workers run them.
  let logBossError = (err: Error) => console.error('pg-boss error', err);
  const boss =
    database && createBoss(database.pool, { role: 'api', onError: (err) => logBossError(err) });
  // Without a queue the API still serves; adoptions then queue no mapping (logged at error).
  const started = await boss?.start().then(
    () => true,
    (err) => {
      logBossError(err);
      return false;
    },
  );
  const app = await buildApp(config, database ? { db: database.db, ...(started && { boss }) } : {});
  logPoolError = (err) => app.log.error({ err }, 'pg pool error');
  logBossError = (err) => app.log.error({ err }, 'pg-boss error');
  await app.listen({ port: config.PORT, host: config.HOST });
  onSignals(app.log, async () => {
    await app.close();
    await boss?.stop({ graceful: true });
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
    onError: (err) => log.error({ err }, 'pg-boss error'),
  });
  await boss.start();
  const jobs = await loadJobs();
  for (const job of jobs) await workScopedJob(boss, database.db, job, log);
  log.info({ jobs: jobs.map((j) => j.name) }, 'worker started');
  // Graceful: active jobs finish (up to pg-boss's stop timeout) before the pool closes.
  onSignals(log, () => boss.stop({ graceful: true }));
}

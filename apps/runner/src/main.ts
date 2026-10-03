import { RUNNER_BOUNDS } from '@parallax/contracts';
import Docker from 'dockerode';
import { PgBoss } from 'pg-boss';
import { loadConfig } from './config';
import { DockerExecutor, imageDaemon, KILL_GRACE_SECONDS } from './executor';
import { ImageAllowlist } from './images';
import { createLogger } from './log';
import { EXEC_SCHEMA, startSlots } from './worker';

const RETRY_MS = 10_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The runner process (design §7.2): pg-boss on `pgboss_exec` without migrations, supervision or
 * scheduling (the server owns the schema and the queues), a sweep of sandbox containers left by
 * a crash, the image allowlist, then one worker per slot. SIGTERM stops fetching and lets running
 * containers finish.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);

  const boss = new PgBoss({
    connectionString: config.RUNNER_DATABASE_URL,
    max: config.RUNNER_SLOTS + 2,
    schema: EXEC_SCHEMA,
    migrate: false,
    supervise: false,
    schedule: false,
  });
  boss.on('error', (err) => log.error({ err }, 'pg-boss error'));
  boss.on('warning', (warning) => log.warn({ warning: warning.message }, 'pg-boss warning'));

  // `start()` only reads pgboss_exec.version; until the server has created it, wait.
  for (;;) {
    try {
      await boss.start();
      break;
    } catch (err) {
      log.warn({ err }, `pgboss_exec is not ready; retrying in ${RETRY_MS / 1000} s`);
      await sleep(RETRY_MS);
    }
  }

  const docker = config.DOCKER_HOST ? new Docker(dockerHost(config.DOCKER_HOST)) : new Docker();
  const executor = new DockerExecutor(docker, config.RUNNER_DOCKER_RUNTIME);
  const swept = await executor.sweep();
  if (swept > 0) log.warn({ swept }, 'removed sandbox containers left by an earlier run');
  await executor.ping();
  const images = new ImageAllowlist(config.RUNNER_IMAGES, imageDaemon(docker), config.RUNNER_PULL);
  await images.resolveAll();

  await startSlots({ boss, executor, images, log }, config.RUNNER_SLOTS);
  log.info({ slots: config.RUNNER_SLOTS }, 'runner started');

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log.info('stopping: no new jobs; waiting for running containers');
    const timeout = (RUNNER_BOUNDS.wallSeconds.max + KILL_GRACE_SECONDS + 10) * 1000;
    await boss.stop({ graceful: true, timeout });
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

/** `DOCKER_HOST` as `unix:///path` or `tcp://host:port`. */
function dockerHost(value: string): Docker.DockerOptions {
  if (value.startsWith('unix://')) return { socketPath: value.slice('unix://'.length) };
  const url = new URL(value.replace(/^tcp:/, 'http:'));
  return { host: url.hostname, port: Number(url.port) || 2375, protocol: 'http' };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

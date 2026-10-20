import { join } from 'node:path';
import { compile, place } from '../build/web';
import { backup, writeBackupFile } from '../host/backup';
import { compose, composeArgs, noServer } from '../host/compose';
import { readEnv, readText } from '../host/secrets';
import type { Command } from '../main';
import { SiteProblems } from '../site/load';
import { run as env } from './env';
import { readable, typedProblems } from './start';

/** The compile into `.parallax/dist` and its placing into `dist/`, which a test replaces. */
export const building = { compile, place };

const stop = (line: string) => {
  console.error(`parallax upgrade: ${line}`);
  return 1;
};

/**
 * `parallax upgrade` (docs/design/site.md §10): `env`, `start`'s check of `.env`, the compile and
 * `pull` (the backup's image too) while the old version serves; then `server` and `worker` stop,
 * a backup is taken, and only then the compiled site goes into `dist/` and `up -d --wait` runs
 * `migrate` first. A failed backup starts no migration and leaves `dist/` as it was.
 */
export const run: Command['run'] = async ({ site }) => {
  if (site.config.level === 0) return noServer('upgrade');
  const written = await env({ site, args: [] });
  if (written !== 0) return written;
  const typed = typedProblems(site, readEnv(readText(join(site.root, '.env'))));
  for (const line of typed) console.error(`parallax upgrade: .env: ${line}`);
  if (typed.length > 0) return 1;
  try {
    await building.compile(site);
  } catch (error) {
    if (error instanceof SiteProblems) throw error;
    return stop(`${(error as Error).message}\nNothing has stopped and dist/ is as it was.`);
  }
  const restart = ['docker', ...composeArgs(site.config.level), 'start server worker'].join(' ');
  const pulled = await compose(site, ['-f', writeBackupFile(site), 'pull']);
  if (pulled !== 0) return stop(`docker compose pull ended with ${pulled}; nothing has stopped.`);
  const stopped = await compose(site, ['stop', 'server', 'worker']);
  if (stopped !== 0) return stop(`docker compose stop ended with ${stopped}. Run: ${restart}`);
  const { code, dir } = await backup(site);
  if (code !== 0) {
    const why = `the backup into ${dir} ended with ${code}, so no migration ran and dist/ is as it was.`;
    return stop(`${why}\nStart the old services again with: ${restart}`);
  }
  const taken = `the backup taken before is ${dir}`;
  try {
    building.place(site.root);
    readable(site.root);
  } catch (error) {
    const why = (error as Error).message;
    return stop(`dist/ was not completed: ${why}\nserver and worker are stopped; ${taken}.`);
  }
  const up = await compose(site, ['up', '-d', '--wait']);
  const which = 'server and worker may be stopped (docker compose ps shows which)';
  if (up !== 0) return stop(`docker compose up ended with ${up}: ${which}; ${taken}.`);
  console.error(`parallax upgrade: the new version is up; ${taken}.`);
  return 0;
};

import { compile, place } from '../build/web';
import { backup } from '../host/backup';
import { compose, composeArgs, noServer } from '../host/compose';
import type { Command } from '../main';
import { SiteProblems } from '../site/load';
import { run as env } from './env';
import { readable } from './start';

/** The compile into `.parallax/dist` and its placing into `dist/`, which a test replaces. */
export const building = { compile, place };

const stop = (line: string) => {
  console.error(`parallax upgrade: ${line}`);
  return 1;
};

/**
 * `parallax upgrade` (docs/design/site.md §10), after the version in `package.json` was changed
 * and installed: `env`, the compile and `pull` while the old version still serves; then `server`
 * and `worker` stop, a backup is taken, and only after it the compiled site goes into `dist/` and
 * `up -d --wait` runs `migrate` before the new services. A failure names its stage and what the
 * operator does next; a failed backup starts no migration and leaves `dist/` as it was.
 */
export const run: Command['run'] = async ({ site }) => {
  if (site.config.level === 0) return noServer('upgrade');
  const written = await env({ site, args: [] });
  if (written !== 0) return written;
  try {
    await building.compile(site);
  } catch (error) {
    if (error instanceof SiteProblems) throw error;
    return stop(`${(error as Error).message}\nNothing has stopped and dist/ is as it was.`);
  }
  const restart = ['docker', ...composeArgs(site.config.level), 'start server worker'].join(' ');
  const pulled = await compose(site, ['pull']);
  if (pulled !== 0) return stop(`docker compose pull ended with ${pulled}; nothing has stopped.`);
  const stopped = await compose(site, ['stop', 'server', 'worker']);
  if (stopped !== 0) return stop(`docker compose stop ended with ${stopped}. Run: ${restart}`);
  const { code, dir } = await backup(site);
  if (code !== 0) {
    const why = `the backup into ${dir} ended with ${code}, so no migration ran and dist/ is as it was.`;
    return stop(`${why}\nStart the old services again with: ${restart}`);
  }
  const stays = `server and worker are stopped; the backup taken before is ${dir}.`;
  try {
    building.place(site.root);
    readable(site.root);
  } catch (error) {
    return stop(`dist/ was not completed: ${(error as Error).message}\n${stays}`);
  }
  const up = await compose(site, ['up', '-d', '--wait']);
  if (up !== 0) return stop(`docker compose up ended with ${up} (migrate or a service): ${stays}`);
  console.error(`parallax upgrade: the new version is up; the backup taken before is ${dir}.`);
  return 0;
};

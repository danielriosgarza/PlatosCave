import { compile, place } from '../build/web';
import type { Command } from '../main';
import { SiteProblems } from '../site/load';

/** Until the level 0 build of run R3 is on main, a level 0 site is not built (site.md §5). */
export const LEVEL_0 = 'parallax: a level 0 site cannot be built or served by this version yet.';
const stop = (line: string) => {
  console.error(line);
  return 1;
};

/**
 * `parallax build` (docs/design/site.md §5, §6.4) at levels 1 and 2: the compile, then `dist/`.
 * A build that stops leaves `dist/` as it was. It opens no file of a course folder, so it needs
 * no private overlay.
 */
export const run: Command['run'] = async ({ site }) => {
  if (site.config.level === 0) return stop(LEVEL_0);
  try {
    await compile(site);
  } catch (error) {
    if (error instanceof SiteProblems) throw error;
    return stop(`parallax build: ${(error as Error).message}\ndist/ is as it was.`);
  }
  try {
    place(site.root);
  } catch (error) {
    const why = `dist/ was not completed: ${(error as Error).message}`;
    const left = 'index.html is put in last, so until it is, dist/ serves the earlier build';
    return stop(`parallax build: ${why}\n${left}. Run parallax build again.`);
  }
  console.error('parallax build: the site is in dist/.');
  return 0;
};

import { compile, place } from '../build/web';
import type { Command } from '../main';
import { noViewerYet } from '../open/shell';
import { SiteProblems } from '../site/load';

export { LEVEL_0 } from '../open/shell';

const stop = (line: string) => {
  console.error(line);
  return 1;
};

/**
 * `parallax build` (docs/design/site.md §5, §6.4) at levels 1 and 2: the compile, then `dist/`. A
 * build that stops leaves `dist/` as it was. It opens no course file, so it needs no overlay. At
 * level 0 the build of docs/design/open-site.md §4, which has no viewer to compile yet: it checks
 * and converts every course, then stops with the level 0 message (P5-16a opens it).
 */
export const run: Command['run'] = async ({ site }) => {
  if (site.config.level === 0) {
    // Loaded here, so that levels 1 and 2 do not load conversion.
    const { buildOpenSite } = await import('../open/build');
    return buildOpenSite(site, { shell: noViewerYet });
  }
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
    const which = 'index.html is put in last: until it is, dist/ serves the earlier build';
    return stop(`parallax build: ${why}\n${which}. Run parallax build again.`);
  }
  console.error('parallax build: the site is in dist/.');
  return 0;
};

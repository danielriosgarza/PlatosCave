import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildPaths, compile } from '../build/web';
import { SiteProblems } from '../site/load';
import type { ShellCompiler } from './build';
import { BuildStop } from './output';

export type { ShellCompiler };

/**
 * The shell of a level 0 site (docs/design/open-site.md §6): the compile of `build/web.ts` with the
 * entry `open`, the site's pages and its read check included, and every file it wrote handed to
 * `out.shell` as it is. Nothing is added to `index.html`, which carries no content security policy.
 */
export const compileOpenShell: ShellCompiler = async (site, out) => {
  try {
    await compile(site, { entry: 'open' });
  } catch (error) {
    // A page's refusal is printed as at levels 1 and 2; any other failure stops the build.
    if (error instanceof SiteProblems) throw error;
    throw new BuildStop(`parallax build: ${(error as Error).message}`);
  }
  const dir = buildPaths(site.root).out;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    out.shell(relative(dir, file).replaceAll('\\', '/'), readFileSync(file));
  }
};

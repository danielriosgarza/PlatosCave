import type { Site } from '../site/load';
import { BuildStop, type Output } from './output';

/** Compiles the shell of a level 0 site and hands its files to `out.shell` (open-site.md §4, §6). */
export type ShellCompiler = (site: Site, out: Output) => Promise<void>;

/** The level 0 stop of P5-07 (docs/design/site.md §5), which `parallax dev` gives as well. */
export const LEVEL_0 = 'parallax: a level 0 site cannot be built or served by this version yet.';

/**
 * The shell of this version: there is no viewer yet (docs/design/open-site.md §10), so a level 0
 * build checks and converts every course and then stops here, before anything is placed. P5-16a
 * puts `compileOpenShell` in its place.
 */
export const noViewerYet: ShellCompiler = async () => {
  throw new BuildStop(LEVEL_0);
};

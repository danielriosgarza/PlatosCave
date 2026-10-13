import { existsSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SiteConfig } from '@parallax/contracts';
import { tsImport } from 'tsx/esm/api';
import { loadSource, packageRoot } from '../paths';

export const CONFIG = 'parallax.config.ts';

/** A loaded site: its folder and its configuration. */
export type Site = { root: string; config: SiteConfig };

/** What stops every command (docs/design/site.md §4): one line for each problem. */
export class SiteProblems extends Error {
  constructor(readonly lines: string[]) {
    super(lines.join('\n'));
  }
}

let answering = false;
/**
 * A configuration imports `defineConfig` from `parallax-site`. The tool answers that name with
 * its own entry, so a site loads where the package is not installed beside it: a fixture, or a
 * test's copy outside the repository. The hook serves ES modules, which a site is when its
 * `package.json` says `"type": "module"`; a CommonJS site finds the installed package itself.
 */
function answerOwnName(): void {
  if (answering) return;
  answering = true;
  const hook = `let entry;
export const initialize = (data) => { entry = data; };
export const resolve = (specifier, context, next) =>
  next(specifier === 'parallax-site' ? entry : specifier, context);`;
  const entry = pathToFileURL(join(packageRoot, 'src/index.ts')).href;
  register(`data:text/javascript,${encodeURIComponent(hook)}`, { data: entry });
}

/**
 * Loads a site's configuration and validates it (docs/design/site.md §4): it writes nothing
 * and throws `SiteProblems`. The checks that need the folder are P5-07b's.
 */
export async function loadSite(root: string): Promise<Site> {
  const file = join(root, CONFIG);
  if (!existsSync(file)) throw new SiteProblems([`${CONFIG}: not found in ${root}`]);
  type Contracts = typeof import('@parallax/contracts');
  const { siteConfig, siteIssueLines } = await loadSource<Contracts>('contracts', 'src/index.ts');
  answerOwnName();
  let exported: unknown;
  try {
    const loaded = await tsImport(pathToFileURL(file).href, import.meta.url);
    // In a CommonJS site the default export lies one level deeper.
    exported = loaded.default?.__esModule ? loaded.default.default : loaded.default;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SiteProblems([`${CONFIG}: ${message.split('\n')[0]}`]);
  }
  const parsed = siteConfig.safeParse(exported);
  if (parsed.success) return { root, config: parsed.data };
  const lines = siteIssueLines(parsed.error.issues);
  throw new SiteProblems(lines.map((line) => `${CONFIG}: ${line}`));
}

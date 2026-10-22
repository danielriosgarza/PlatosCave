import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The folder of the package `parallax-site`. */
export const packageRoot = resolve(import.meta.dirname, '..');

/**
 * Where each source the tool works with lies in the repository; `deploy` holds `backup.sh`, and
 * `scaffold` the scaffolder's create module and templates, which `update` lays out.
 */
const inRepository = {
  web: 'apps/web',
  ui: 'packages/ui',
  contracts: 'packages/contracts',
  server: 'apps/server',
  deploy: 'scripts',
  scaffold: 'packages/create-parallax-site',
} as const;
export type Source = keyof typeof inRepository;

/**
 * The folder of one of these sources (docs/design/site.md §2): `vendor/<name>` in the published
 * package, laid out as the source's folder in the repository, and that folder itself in the
 * repository, where `vendor/` does not exist.
 */
export function sourceRoot(name: Source): string {
  const vendor = join(packageRoot, 'vendor');
  if (existsSync(vendor)) return join(vendor, name);
  return resolve(packageRoot, '../..', inRepository[name]);
}

/**
 * Imports a module of one of the sources when the tool runs. The tool's own files reach them
 * only so, and name a workspace package in type imports alone, which leave no import behind.
 */
export function loadSource<T>(name: Source, file: string): Promise<T> {
  return import(pathToFileURL(join(sourceRoot(name), file)).href);
}

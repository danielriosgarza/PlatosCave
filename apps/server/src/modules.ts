import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface LoadedModule {
  /** File name within the directory, for error messages. */
  file: string;
  mod: Record<string, unknown>;
}

/**
 * Imports every `*<suffix>` file of `dir` in name order. Route and job modules are discovered
 * this way, so features add files instead of lines in a shared list.
 */
export async function loadModules(dir: string, suffix: string): Promise<LoadedModule[]> {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .sort();
  const modules: LoadedModule[] = [];
  for (const file of files) {
    modules.push({ file, mod: await import(pathToFileURL(resolve(dir, file)).href) });
  }
  return modules;
}

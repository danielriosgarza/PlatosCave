import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageRoot } from '../paths';

// Support for the tests of a level 0 build; not packed (package.json `files`).

/** The address of a module of the tool, for an `import()` of the code `underGuard` runs. */
export const moduleUrl = (file: string) => pathToFileURL(join(packageRoot, 'src', file)).href;

/**
 * Runs `code`, an ES module's text, in a child process under the file-read guard (`read-guard.mjs`,
 * docs/design/open-site.md §10, check 1) for one site: `site` is its folder and `courses` are its
 * course folders. The code is a file of its own, as worker threads inherit the child's options; it
 * loads TypeScript with tsx, as `bin/parallax.mjs` does, and has no `DATABASE_URL`. It gives the
 * exit status, the output, and each call the guard refused, in order: its name, the path it
 * named, and that path with its links resolved.
 */
export function underGuard(places: { site: string; courses: string[] }, code: string) {
  // In the tool's node_modules, where `tsx` resolves and git looks at nothing.
  const cache = join(packageRoot, 'node_modules/.cache');
  fs.mkdirSync(cache, { recursive: true });
  const folder = fs.mkdtempSync(join(cache, 'guard-'));
  const [log, script] = [join(folder, 'refused.jsonl'), join(folder, 'run.mjs')];
  fs.writeFileSync(script, `import { register } from 'tsx/esm/api';\nregister();\n${code}`);
  // A variable without a value is not passed on.
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: undefined };
  env.PARALLAX_READ_GUARD = JSON.stringify({ ...places, log });
  const guard = pathToFileURL(join(import.meta.dirname, 'read-guard.mjs')).href;
  const args = ['--import', guard, script];
  const run = spawnSync(process.execPath, args, { cwd: packageRoot, env, encoding: 'utf8' });
  const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n') : [];
  fs.rmSync(folder, { recursive: true, force: true });
  const refused: { call: string; path: string; real: string }[] = lines
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, refused };
}

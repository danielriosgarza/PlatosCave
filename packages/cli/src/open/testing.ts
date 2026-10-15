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
  // A variable without a value is not passed on: neither DATABASE_URL nor a variable PG….
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: undefined };
  for (const name of Object.keys(env).filter((name) => name.startsWith('PG')))
    env[name] = undefined;
  env.PARALLAX_READ_GUARD = JSON.stringify({ ...places, log });
  const guard = pathToFileURL(join(import.meta.dirname, 'read-guard.mjs')).href;
  const options = { cwd: packageRoot, env, encoding: 'utf8', timeout: 240_000 } as const;
  const run = spawnSync(process.execPath, ['--import', guard, script], options);
  const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n') : [];
  fs.rmSync(folder, { recursive: true, force: true });
  const refused: { call: string; path: string; real: string }[] = lines
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, refused };
}

/** Every file below `dir`, by `prefix` and its path from `dir` with `/`; none if it is absent. */
export function filesOf(dir: string, prefix = ''): Map<string, Buffer> {
  const all = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }) : [];
  const files = all.filter((path) => fs.statSync(join(dir, path)).isFile()).sort();
  return new Map(
    files.map((path) => [prefix + path.replaceAll('\\', '/'), fs.readFileSync(join(dir, path))]),
  );
}

/** What `run` prints with console.log and console.error, in order, beside what it gives. */
export async function printing<T>(run: () => Promise<T>) {
  const [lines, { log, error }] = [[] as string[], console];
  console.log = console.error = (line: string) => void lines.push(line);
  try {
    return { result: await run(), lines };
  } finally {
    Object.assign(console, { log, error });
  }
}

/** The stand-in for the shell (open-site.md §10): a `ShellCompiler`'s code that writes two files. */
export const STAND_IN = `async (site, out) => {
  out.shell('index.html', Buffer.from('<!doctype html><script type="module" src="/assets/open.js"></script>'));
  out.shell('assets/open.js', Buffer.from('export const shell = "stand-in";'));
}`;

/**
 * Builds the site at `root` at level 0 under the file-read guard, which guards its course folders
 * in either mode: `buildOpenSite` with `shell`, a `ShellCompiler`'s code that may use `fs`, `join`
 * and `root`, or with `command: true` the command `parallax build`. It gives what `underGuard` gives,
 * and every file of `.parallax/open/` and `dist/`, by its path from the site.
 */
export function buildUnderGuard(root: string, { shell = STAND_IN, command = false } = {}) {
  const listed = (dir: string) =>
    (fs.existsSync(dir) ? fs.readdirSync(dir) : []).map((name) => join(dir, name));
  const instructors = listed(join(root, 'instructors')).map((dir) => join(dir, 'courses'));
  const courses = [join(root, 'courses'), ...instructors].flatMap(listed);
  const build = command
    ? `main(['build'], { cwd: root })`
    : `buildOpenSite(await loadSite(root), { shell: ${shell} })`;
  const at = (file: string) => JSON.stringify(moduleUrl(file));
  const run = underGuard(
    { site: root, courses },
    `const [fs, { join }] = [await import('node:fs'), await import('node:path')];
    const { main } = await import(${at('main.ts')});
    const { loadSite } = await import(${at('site/load.ts')});
    const { buildOpenSite } = await import(${at('open/build.ts')});
    const root = ${JSON.stringify(root)};
    process.exitCode = await ${build};`,
  );
  const files = new Map([
    ...filesOf(join(root, '.parallax/open'), '.parallax/open/'),
    ...filesOf(join(root, 'dist'), 'dist/'),
  ]);
  return { ...run, files };
}

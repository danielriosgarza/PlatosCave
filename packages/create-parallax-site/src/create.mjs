// `npm create parallax-site <folder> [-- --template instructor|school]` (docs/design/site.md §5).
// Plain JavaScript with no dependency, so that npm create installs nothing else to run it.
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const own = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATES = ['instructor', 'school'];
/** The files the templates hold under another name, each written as `.<name>` (§3). */
const RENAMED = ['_gitignore', '_npmrc', '_gitattributes'];
const USAGE = 'usage: npm create parallax-site <folder> [-- --template instructor|school]';
const FLAGS = /** @type {const} */ ({
  template: { type: 'string', default: 'instructor' },
  help: { type: 'boolean', short: 'h' },
});

/**
 * Creates a site folder from a template: the shared files, then the mode's, with `_gitignore`,
 * `_npmrc` and `_gitattributes` under their real names (npm delivers no file of the first two names
 * in a package), and a `package.json` whose one dependency is `parallax-site` at `version`, by
 * default the scaffolder's own. It asks nothing, uses no network, runs no install and refuses a
 * folder that is not empty. Returns the exit code: 0 (`--help` too, which prints the usage on the
 * standard output), 1 for a folder refused or not written, 2 for usage.
 * @param {string[]} argv
 * @param {{ cwd?: string, version?: string, print?: (line: string) => void }} [options]
 * @returns {number}
 */
export function create(argv, options = {}) {
  const { cwd = process.cwd(), print = console.error } = options;
  const usage = (/** @type {0 | 2} */ code) => {
    (code === 0 ? console.log : print)(USAGE);
    return code;
  };
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: FLAGS, allowPositionals: true });
  } catch {
    return usage(2);
  }
  const [folder, ...more] = parsed.positionals;
  const { template, help } = parsed.values;
  if (help) return usage(0);
  if (!folder || more.length > 0 || !TEMPLATES.includes(template)) return usage(2);
  const target = resolve(cwd, folder);
  const there = fs.statSync(target, { throwIfNoEntry: false });
  if (there && (!there.isDirectory() || fs.readdirSync(target).length > 0)) {
    print(`create-parallax-site: ${folder} is not empty. Name a new or empty folder.`);
    return 1;
  }
  try {
    for (const from of ['shared', template]) {
      fs.cpSync(join(own, 'templates', from), target, { recursive: true });
    }
    for (const name of RENAMED)
      fs.renameSync(join(target, name), join(target, name.replace('_', '.')));
    const manifest = JSON.parse(fs.readFileSync(join(own, 'package.json'), 'utf8'));
    const dependencies = { 'parallax-site': options.version ?? manifest.version };
    const site = { private: true, type: 'module', dependencies };
    fs.writeFileSync(join(target, 'package.json'), `${JSON.stringify(site, null, 2)}\n`);
  } catch (error) {
    // What this run wrote goes: the folder was new or empty, and a second run takes it empty.
    for (const name of fs.existsSync(target) ? fs.readdirSync(target) : []) {
      fs.rmSync(join(target, name), { recursive: true, force: true });
    }
    const why = /** @type {NodeJS.ErrnoException} */ (error).code ?? String(error);
    print(`create-parallax-site: ${folder} could not be written (${why}).`);
    return 1;
  }
  const next = target === resolve(cwd) ? 'npm install' : `cd ${folder}, then npm install`;
  print(`Created ${folder} from the ${template} template. Next: ${next}.`);
  return 0;
}

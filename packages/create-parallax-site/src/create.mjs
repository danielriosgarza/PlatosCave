// `npm create parallax-site <folder> [-- --template instructor|school]` (docs/design/site.md §5).
// Plain JavaScript with no dependency, so that npm create installs nothing else to run it.
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const own = resolve(import.meta.dirname, '..');
const TEMPLATES = ['instructor', 'school'];
const USAGE = 'usage: npm create parallax-site <folder> [-- --template instructor|school]';

/**
 * Creates a site folder from a template: the shared files, then the mode's, with `_gitignore`,
 * `_npmrc` and `_gitattributes` under their real names (npm delivers no file of the first two names
 * in a package), and a `package.json` whose one dependency is `parallax-site` at `version`, by
 * default the scaffolder's own. It asks nothing, uses no network, runs no install and refuses a
 * folder that is not empty. Returns the exit code: 0, 1 for a refused folder, 2 for usage.
 * @param {string[]} argv
 * @param {{ cwd?: string, version?: string, print?: (line: string) => void }} [options]
 * @returns {number}
 */
export function create(argv, options = {}) {
  const { cwd = process.cwd(), print = console.error } = options;
  let parsed;
  try {
    const flags = { template: { type: /** @type {const} */ ('string'), default: 'instructor' } };
    parsed = parseArgs({ args: argv, options: flags, allowPositionals: true });
  } catch {
    print(USAGE);
    return 2;
  }
  const [folder, ...more] = parsed.positionals;
  const { template } = parsed.values;
  if (!folder || more.length > 0 || !TEMPLATES.includes(template)) {
    print(USAGE);
    return 2;
  }
  const target = resolve(cwd, folder);
  const there = fs.statSync(target, { throwIfNoEntry: false });
  if (there && (!there.isDirectory() || fs.readdirSync(target).length > 0)) {
    print(`create-parallax-site: ${folder} is not empty. Name a new or empty folder.`);
    return 1;
  }
  for (const from of ['shared', template]) {
    fs.cpSync(join(own, 'templates', from), target, { recursive: true });
  }
  for (const name of fs.readdirSync(target).filter((name) => name.startsWith('_'))) {
    fs.renameSync(join(target, name), join(target, `.${name.slice(1)}`));
  }
  const manifest = JSON.parse(fs.readFileSync(join(own, 'package.json'), 'utf8'));
  const dependencies = { 'parallax-site': options.version ?? manifest.version };
  const site = { private: true, type: 'module', dependencies };
  fs.writeFileSync(join(target, 'package.json'), `${JSON.stringify(site, null, 2)}\n`);
  print(`Created ${folder} from the ${template} template. Next: cd ${folder}, then npm install.`);
  return 0;
}

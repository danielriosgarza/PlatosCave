// `npm create parallax-site <folder> [-- --template instructor|school]` (docs/design/site.md §5).
// Plain JavaScript with no dependency, so that npm create installs nothing else to run it.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const own = resolve(import.meta.dirname, '..');
const TEMPLATES = ['instructor', 'school'];
/** The files the templates hold under another name, each written as `.<name>` (§3). */
const RENAMED = ['_gitignore', '_npmrc', '_gitattributes'];
const USAGE = 'usage: npm create parallax-site <folder> [-- --template instructor|school]';
const FLAGS = /** @type {const} */ ({
  template: { type: 'string', default: 'instructor' },
  help: { type: 'boolean', short: 'h' },
});
/**
 * The file in which a site keeps the fingerprint of each file its template gave it, as the
 * scaffolder or the last `parallax update` wrote them, so that an update tells a file the author
 * changed from one they did not (§10.1).
 */
export const RECORD = '.parallax-template.json';

/**
 * Writes the files of a new site of `template` into the folder `target`: the shared files, then
 * the mode's (in school mode also the instructor template's starter course and its overlay in
 * `private/`), with `_gitignore`, `_npmrc` and `_gitattributes` under their real names (npm
 * delivers no file of the first two names in a package). It writes no `package.json` and no
 * record. `parallax update` lays out the template of its own version with it.
 * @param {string} target
 * @param {string} template
 */
export function lay(target, template) {
  for (const from of ['shared', template]) {
    fs.cpSync(join(own, 'templates', from), target, { recursive: true });
  }
  // The instructor template's starter course, Welcome to Parallax, is the first instructor's in
  // a school site too, with its overlay at the matching path of private/.
  if (template === 'school') {
    const welcome = join(own, 'templates', 'instructor');
    const ana = join('instructors', 'ana', 'courses');
    fs.cpSync(join(welcome, 'courses'), join(target, ana), { recursive: true });
    fs.cpSync(join(welcome, 'private', 'courses'), join(target, 'private', ana), {
      recursive: true,
    });
  }
  for (const name of RENAMED)
    fs.renameSync(join(target, name), join(target, name.replace('_', '.')));
}

/**
 * A file's fingerprint: the SHA-256 of its bytes with each CRLF read as LF, so that a checkout
 * with Windows line ends has the fingerprint of the template's file.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function fingerprint(bytes) {
  const text = Buffer.from(bytes).toString('latin1').replaceAll('\r\n', '\n');
  return createHash('sha256').update(text, 'latin1').digest('hex');
}

/**
 * The fingerprint of each file under `dir` but `package.json` and the record, by its path from
 * `dir` written with `/`, in sorted order.
 * @param {string} dir
 * @returns {Record<string, string>}
 */
export function fingerprints(dir) {
  const paths = fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .filter((path) => path !== 'package.json' && path !== RECORD)
    .sort();
  return Object.fromEntries(
    paths.map((path) => [path, fingerprint(fs.readFileSync(join(dir, path)))]),
  );
}

/**
 * Writes the record of `files`, fingerprints by path, into the site folder `target`.
 * @param {string} target
 * @param {Record<string, string>} files
 */
export function writeRecord(target, files) {
  fs.writeFileSync(join(target, RECORD), `${JSON.stringify({ files }, null, 2)}\n`);
}

/**
 * Creates a site folder from a template (`lay`), with the record of the files it wrote and a
 * `package.json` whose one dependency is `parallax-site` at `version`, by default the
 * scaffolder's own. It asks nothing, uses no network, runs no install and refuses a folder that
 * is not empty. Returns the exit code: 0 (`--help` too, which prints the usage on the standard
 * output), 1 for a folder refused or not written, 2 for usage.
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
    lay(target, template);
    writeRecord(target, fingerprints(target));
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

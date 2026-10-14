import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { register } from 'node:module';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { InstructorMeta, SiteConfig } from '@parallax/contracts';
import { tsImport } from 'tsx/esm/api';
import { parseYaml } from '../folder/yaml';
import { loadSource, packageRoot } from '../paths';

export const CONFIG = 'parallax.config.ts';
type Contracts = typeof import('@parallax/contracts');

/** A listed instructor folder that passed every check (docs/design/site.md §7). */
export type InstructorFolder = {
  /** As `instructors` of the configuration names it: `.`, or the folder's name in school mode. */
  ref: string;
  /** From the site folder, written with `/`: `.` or `instructors/<name>`. */
  path: string;
  /** The content of its `instructor.yaml`. */
  meta: InstructorMeta;
  /** Its course folders, by the names the directory listing gives, sorted. */
  courses: string[];
};
/**
 * A loaded site: its folder, its configuration and its instructor folders. This module owns the
 * scan of the instructor folders, with its rules on case, Unicode form and a missing folder: a
 * later reader (the catalogue of P5-07, `apply`) takes `instructors` from here and scans nothing.
 */
export type Site = { root: string; config: SiteConfig; instructors: InstructorFolder[] };

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

/** The names in a folder, as its listing gives them, of its folders or of its other entries. */
function listed(dir: string, folders: boolean): string[] {
  const names = statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? readdirSync(dir) : [];
  // A name that starts with a dot is skipped, as the reader of a course folder skips it.
  const kind = (name: string) =>
    statSync(join(dir, name), { throwIfNoEntry: false })?.isDirectory();
  return names.filter((name) => !name.startsWith('.') && kind(name) === folders).sort();
}
const fold = (name: string) => name.normalize('NFC').toLowerCase();
/** A name with each character outside printable ASCII as its code point: two forms read apart. */
const shown = (name: string) =>
  name.replace(/[^\x20-\x7e]/gu, (char) => `\\u{${char.codePointAt(0)?.toString(16)}}`);

/**
 * Why `name` is not in `names`, which the directory listing gave. A file system that ignores case
 * or Unicode form opens a folder under any spelling, and a name has one source, the listing
 * (docs/design/course-folder.md §4.2), so the listed spelling alone is taken.
 */
function absent(name: string, names: string[], missing: string): string | undefined {
  if (names.includes(name)) return undefined;
  const near = names.find((other) => fold(other) === fold(name));
  if (near === undefined) return missing;
  return `the name on disk is ${shown(near)}, not ${shown(name)} (case or Unicode form)`;
}

/** Why the logo cannot be used: it lies outside the site, where course material lies, or nowhere. */
function logoProblem(root: string, file: string): string | undefined {
  if (/^[/\\]|\\|:|(^|\/)\.\.(\/|$)/.test(file)) {
    return `${file} is not a path inside the site folder, written with / and without .. or :`;
  }
  if (!statSync(join(root, file), { throwIfNoEntry: false })?.isFile()) return `no file ${file}`;
  // By the real path, so that a link which leads out of the site or into a course folder counts.
  const real = relative(realpathSync.native(root), realpathSync.native(join(root, file)));
  const [top, , third] = fold(real).split(sep);
  if (top === '..' || isAbsolute(real)) return `${file} lies outside the site folder`;
  // Both modes' course folders, which move between the modes unchanged, and the overlay.
  if (top === 'courses' || top === 'private' || (top === 'instructors' && third === 'courses')) {
    return `${file} lies in a course folder or the private overlay`;
  }
}

/**
 * The checks that need the folder (docs/design/site.md §4 and §7), one line for each problem with
 * its path. They read directory listings and `instructor.yaml`, and no file of a course folder.
 */
function checkFolder(root: string, config: SiteConfig, contracts: Contracts) {
  const school = config.mode === 'school';
  const problems: string[] = [];
  const onDisk = school ? listed(join(root, 'instructors'), true) : [];
  const addresses = new Map<string, string>();
  const instructors: InstructorFolder[] = [];
  for (const [i, ref] of config.instructors.entries()) {
    const path = school ? `instructors/${ref}` : '.';
    const missing = school ? absent(ref, onDisk, `no folder ${path}`) : undefined;
    if (missing) {
      problems.push(`${CONFIG}: instructors[${i}]: ${missing}`);
      continue;
    }
    const count = problems.length;
    const at = (name: string) => posix.join(path, name);
    const yaml = at('instructor.yaml');
    const noYaml = absent('instructor.yaml', listed(join(root, path), false), 'not found');
    let meta: InstructorMeta | undefined;
    if (noYaml) problems.push(`${yaml}: ${noYaml}`);
    else {
      const read = parseYaml(readFileSync(join(root, yaml), 'utf8'), yaml);
      problems.push(
        ...read.problems.map((p) => `${yaml}: ${p.line ? `line ${p.line}: ` : ''}${p.message}`),
      );
      const parsed = read.problems.length
        ? undefined
        : contracts.instructorMeta.safeParse(read.value);
      meta = parsed?.data;
      const lines = contracts.siteIssueLines(parsed?.error?.issues ?? []);
      problems.push(...lines.map((line) => `${yaml}: ${line}`));
    }
    // Accounts are keyed by the address in lower case, as the server reads INSTRUCTOR_EMAILS.
    const address = meta?.email.toLowerCase();
    const twin = address && addresses.get(address);
    if (twin) problems.push(`${yaml}: email: the same address as ${twin}`);
    else if (address) addresses.set(address, yaml);
    const noCourses = absent('courses', listed(join(root, path), true), 'not found');
    if (noCourses) problems.push(`${at('courses')}: ${noCourses}`);
    if (meta && problems.length === count) {
      instructors.push({ ref, path, meta, courses: listed(join(root, at('courses')), true) });
    }
  }
  for (const name of onDisk) {
    if (config.instructors.some((ref) => fold(ref) === fold(name))) continue;
    problems.push(`instructors/${name}: the folder is not in instructors of ${CONFIG}`);
  }
  config.classes.forEach((cls, i) => {
    const [first = '', second] = cls.course.split('/');
    // A class of an instructor folder refused above adds no line of its own.
    const holder = instructors.find((folder) => folder.ref === (school ? first : '.'));
    const name = second ?? first;
    const path = holder && posix.join(holder.path, 'courses', name);
    const why = holder && absent(name, holder.courses, `no folder ${path}`);
    if (why) problems.push(`${CONFIG}: classes[${i}].course: ${why}`);
  });
  const logo = config.logo && logoProblem(root, config.logo.file);
  if (logo) problems.push(`${CONFIG}: logo.file: ${logo}`);
  return { problems, instructors };
}

/**
 * Loads a site's configuration, validates it and checks it against the folder (docs/design/site.md
 * §4): it writes nothing, opens no file of a course folder and throws `SiteProblems`.
 */
export async function loadSite(root: string): Promise<Site> {
  const file = join(root, CONFIG);
  const stop = (lines: string[]) => new SiteProblems(lines.map((line) => `${CONFIG}: ${line}`));
  if (!existsSync(file)) throw stop([`not found in ${root}`]);
  const contracts = await loadSource<Contracts>('contracts', 'src/index.ts');
  const { siteConfig, siteIssueLines } = contracts;
  answerOwnName();
  let exported: unknown;
  try {
    const loaded = await tsImport(pathToFileURL(file).href, import.meta.url);
    // In a CommonJS site the default export lies one level deeper.
    exported = loaded.default?.__esModule ? loaded.default.default : loaded.default;
  } catch (error) {
    const lines = (error instanceof Error ? error.message : String(error)).split('\n');
    // A file that does not compile gives a header, then one line for each error with its place.
    const errors = lines.filter((line) => line.includes(': ERROR: '));
    if (errors.length > 0) throw stop(errors);
    // A thrown error: its name, and its first place in a file of the site folder, where the
    // source maps that tsx enables give the line of the TypeScript file.
    const dir = join(root, sep);
    const frames = error instanceof Error ? (error.stack?.split('\n').slice(1) ?? []) : [];
    const under = (line: string) =>
      [dir, pathToFileURL(dir).href].flatMap((from) => line.split(from)[1] ?? []);
    const place = frames
      .flatMap(under)[0]
      ?.replace(/\?[^:]*|\)$/g, '')
      .replaceAll('\\', '/');
    const name = error instanceof Error ? `${error.name}: ` : '';
    throw stop([`${name}${lines[0]}${place ? `, at ${place}` : ''}`]);
  }
  if (exported === undefined) throw stop(['the configuration is not the default export']);
  const thenable = typeof (exported as { then?: unknown } | null)?.then === 'function';
  if (typeof exported !== 'object' || exported === null || thenable) {
    throw stop(['the default export must be the object that defineConfig returns']);
  }
  const parsed = siteConfig.safeParse(exported);
  if (!parsed.success) throw stop(siteIssueLines(parsed.error.issues));
  const { problems, instructors } = checkFolder(root, parsed.data, contracts);
  if (problems.length > 0) throw new SiteProblems(problems);
  return { root, config: parsed.data, instructors };
}

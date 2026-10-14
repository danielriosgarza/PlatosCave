import {
  type Dirent,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
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
 * later reader (the catalogue of P5-07, `apply`) takes `instructors` from here instead of reading
 * `instructors/` again. `meta.email` is an address: the catalogue keeps names and titles only.
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

/**
 * A name or path for a line: control, format and separator characters as code points, so that it
 * cannot break or hide a line, and in a name not in NFC every character outside ASCII as well, so
 * that two Unicode forms of one name read apart.
 */
const shown = (name: string) =>
  name.replace(
    name === name.normalize('NFC') ? /[\p{C}\p{Zl}\p{Zp}]/gu : /[^\x20-\x7e]/gu,
    (char) => `\\u{${char.codePointAt(0)?.toString(16)}}`,
  );
/** Why an entry cannot be read, without its absolute path. */
const unreadable = (error: unknown) =>
  `cannot be read (${(error as NodeJS.ErrnoException).code ?? String(error).split('\n')[0]})`;

/**
 * The entries of a folder by the names its listing gives, folders apart from the others, sorted;
 * a link counts as what it leads to. A name that starts with a dot is skipped, as the reader of a
 * course folder skips it. `path` is from the site folder; an entry it cannot read is a problem.
 */
function listed(root: string, path: string, problems: string[]) {
  const found = { folders: [] as string[], files: [] as string[] };
  const dir = join(root, path);
  let entries: Dirent[] = [];
  try {
    const folder = statSync(dir, { throwIfNoEntry: false })?.isDirectory();
    entries = folder ? readdirSync(dir, { withFileTypes: true }) : [];
  } catch (error) {
    problems.push(`${shown(path)}: ${unreadable(error)}`);
  }
  for (const entry of entries.filter(({ name }) => !name.startsWith('.'))) {
    try {
      const link = entry.isSymbolicLink();
      const kind = link ? statSync(join(dir, entry.name), { throwIfNoEntry: false }) : entry;
      (kind?.isDirectory() ? found.folders : found.files).push(entry.name);
    } catch (error) {
      problems.push(`${shown(posix.join(path, entry.name))}: ${unreadable(error)}`);
    }
  }
  return { folders: found.folders.sort(), files: found.files.sort() };
}
const fold = (name: string) => name.normalize('NFC').toLowerCase();
/** The listed name that differs from `name` only in case or Unicode form, the first by order. */
const nearest = (name: string, names: string[]) =>
  names.find((other) => fold(other) === fold(name));

/**
 * Why `name` is not in `names`, which the directory listing gave. A file system that ignores case
 * or Unicode form opens a folder under any spelling, and a name has one source, the listing
 * (docs/design/course-folder.md §4.2), so the listed spelling alone is taken.
 */
function absent(name: string, names: string[], missing: string): string | undefined {
  if (names.includes(name)) return undefined;
  const near = nearest(name, names);
  if (near === undefined) return missing;
  return `the name on disk is ${shown(near)}, not ${shown(name)} (case or Unicode form)`;
}

/** Why the logo cannot be used: it lies outside the site, where course material lies, or nowhere. */
function logoProblem(root: string, file: string): string | undefined {
  const named = shown(file);
  if (/^[/\\]|[\\:\p{Cc}]|(^|\/)\.\.(\/|$)/u.test(file)) {
    return `${named} is not a path inside the site folder, written with / and without .. or :`;
  }
  try {
    // Each part as the listing spells it, as a course's name: a file system that ignores case
    // opens the file under any spelling, and the host that builds the site may not.
    let dir = root;
    for (const part of file.split('/').filter((part) => part !== '' && part !== '.')) {
      const names = statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? readdirSync(dir) : [];
      const why = absent(part, names, '');
      if (why === '') return `no file ${named}`;
      if (why) return `${named}: ${why}`;
      dir = join(dir, part);
    }
    if (!statSync(dir, { throwIfNoEntry: false })?.isFile()) return `no file ${named}`;
    // By the real path, so that a link which leads out of the site or into a course folder counts.
    const real = relative(realpathSync.native(root), realpathSync.native(dir));
    const [top, , third] = fold(real).split(sep);
    if (top === '..' || isAbsolute(real)) return `${named} lies outside the site folder`;
    // Both modes' course folders, which move between the modes unchanged, and the overlay.
    if (top === 'courses' || top === 'private' || (top === 'instructors' && third === 'courses')) {
      return `${named} lies in a course folder or the private overlay`;
    }
  } catch (error) {
    return `${named}: ${unreadable(error)}`;
  }
}

/**
 * Reads `instructor.yaml` of an instructor folder, whose listed file names are `files`: its content
 * where it is valid, and its address in lower case where the address alone is, so that the check
 * for two folders with one address counts it while another key is wrong.
 */
function readInstructor(root: string, path: string, files: string[], contracts: Contracts) {
  const problems: string[] = [];
  const label = shown(path);
  const missing = absent('instructor.yaml', files, 'not found');
  if (missing) return { problems: [`${label}: ${missing}`] };
  let text: string;
  try {
    text = readFileSync(join(root, path), 'utf8');
  } catch (error) {
    return { problems: [`${label}: ${unreadable(error)}`] };
  }
  const read = parseYaml(text, path);
  for (const { line, message } of read.problems) {
    problems.push(`${label}: ${line ? `line ${line}: ` : ''}${message}`);
  }
  if (read.problems.length > 0) return { problems };
  const parsed = contracts.instructorMeta.safeParse(read.value);
  const lines = contracts.siteIssueLines(parsed.error?.issues ?? []);
  problems.push(...lines.map((line) => `${label}: ${line}`));
  const given = (read.value as { email?: unknown } | null)?.email;
  const email = contracts.instructorMeta.shape.email.safeParse(given).data;
  return { problems, meta: parsed.data, address: email?.toLowerCase() };
}

/**
 * The checks that need the folder (docs/design/site.md §4 and §7), one line for each problem with
 * its path. They read directory listings and `instructor.yaml`, and no file of a course folder.
 */
function checkFolder(root: string, config: SiteConfig, contracts: Contracts) {
  const school = config.mode === 'school';
  const problems: string[] = [];
  const onDisk = school ? listed(root, 'instructors', problems).folders : [];
  const addresses = new Map<string, string>();
  const instructors: InstructorFolder[] = [];
  for (const [i, ref] of config.instructors.entries()) {
    const path = school ? `instructors/${ref}` : '.';
    const missing = school ? absent(ref, onDisk, `no folder ${shown(path)}`) : undefined;
    if (missing) {
      problems.push(`${CONFIG}: instructors[${i}]: ${missing}`);
      continue;
    }
    const count = problems.length;
    const at = (name: string) => posix.join(path, name);
    const entries = listed(root, path, problems);
    const yaml = at('instructor.yaml');
    const { meta, address, ...read } = readInstructor(root, yaml, entries.files, contracts);
    problems.push(...read.problems);
    // Accounts are keyed by the address in lower case, as the server reads INSTRUCTOR_EMAILS.
    const twin = address && addresses.get(address);
    if (twin) problems.push(`${shown(yaml)}: email: the same address as ${twin}`);
    else if (address) addresses.set(address, shown(yaml));
    const noCourses = absent('courses', entries.folders, 'not found');
    if (noCourses) problems.push(`${shown(at('courses'))}: ${noCourses}`);
    const courses = noCourses ? [] : listed(root, at('courses'), problems).folders;
    if (meta && problems.length === count) instructors.push({ ref, path, meta, courses });
  }
  for (const name of onDisk) {
    // Not listed, unless an absent reference named it above as its spelling on disk.
    const named = (ref: string) => !onDisk.includes(ref) && nearest(ref, onDisk) === name;
    if (config.instructors.includes(name) || config.instructors.some(named)) continue;
    problems.push(`instructors/${shown(name)}: the folder is not in instructors of ${CONFIG}`);
  }
  config.classes.forEach((cls, i) => {
    const [first = '', second] = cls.course.split('/');
    // A class of an instructor folder refused above adds no line of its own.
    const holder = instructors.find((folder) => folder.ref === (school ? first : '.'));
    const name = second ?? first;
    const path = holder && shown(posix.join(holder.path, 'courses', name));
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
    // A thrown error: its name, and its first place in a file of the site folder, outside
    // node_modules where there is one; the source maps that tsx enables give the TypeScript line.
    // A module's address holds its real path, so the site folder counts in both forms.
    const dirs = [root, realpathSync(root)].map((dir) => join(dir, sep));
    const from = [...dirs, ...dirs.map((dir) => pathToFileURL(dir).href)];
    const stack = error instanceof Error ? (error.stack?.split('\n') ?? []) : [];
    const places = stack
      .filter((line) => /^\s+at /.test(line))
      .flatMap((line) => from.flatMap((dir) => line.split(dir)[1] ?? []))
      .map((place) => place.replace(/\?[^:]*|\)$/g, '').replaceAll('\\', '/'));
    const place = places.find((at) => !/(^|\/)node_modules\//.test(at)) ?? places[0];
    const said = [error instanceof Error ? error.name : '', lines[0]].filter(Boolean).join(': ');
    throw stop([`${said}${place ? `, at ${place}` : ''}`]);
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

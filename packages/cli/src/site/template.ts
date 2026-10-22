import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
} from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { loadSource } from '../paths';

/** Fingerprints of files by their path from the site folder, written with `/`. */
export type Prints = Record<string, string>;
type Mode = 'instructor' | 'school';
/** What `update` takes from the scaffolder's create module, of the tool's own version. */
export type Scaffold = {
  RECORD: string;
  lay(target: string, template: Mode): void;
  fingerprint(bytes: Uint8Array): string;
  fingerprints(dir: string): Prints;
  writeRecord(target: string, files: Prints): void;
};

/** Where `update` lays out the template of the tool's version, so that the author can compare. */
export const TEMPLATE = '.parallax/template';

/**
 * The fingerprints of the files a new site got from each published version that wrote no record,
 * by mode: 0.1.0-rc.1, 0.1.0 and 0.1.1, made from the published scaffolder by
 * `scripts/legacy-templates.ts`. Every later site carries its record, so the list does not grow.
 * A test replaces it.
 */
export const published: { versions: Record<string, Record<Mode, Prints>> } = {
  versions: JSON.parse(readFileSync(join(import.meta.dirname, 'legacy-templates.json'), 'utf8')),
};

/**
 * The parts of a site that `update` replaces whole or not at all (docs/design/site.md §10.1): the
 * author's own files (`own`), never written; each course folder with its overlay (`course`) and
 * the front page with its helpers (`pages`), replaced when the site's copy is the template's and
 * never added; and each other file (`file`), replaced when it is the template's and added when it
 * is new in the template.
 */
type Kind = 'own' | 'course' | 'pages' | 'file';
type Part = { kind: Kind; name: string; folders: string[] };
const OWN = /^(parallax\.config\.ts|instructor\.yaml|instructors\/[^/]+\/instructor\.yaml)$/;
const COURSE = /^(?:private\/)?((?:instructors\/[^/]+\/)?courses\/[^/]+)\//;

export function partOf(path: string): Part {
  if (OWN.test(path)) return { kind: 'own', name: path, folders: [] };
  const course = COURSE.exec(path)?.[1];
  if (course) return { kind: 'course', name: course, folders: [course, `private/${course}`] };
  if (path.startsWith('src/pages/')) return { kind: 'pages', name: 'src/pages', folders: [] };
  return { kind: 'file', name: path, folders: [] };
}

/** What an update writes, removes and leaves to the author. */
export type Plan = {
  /** Files copied from the laid-out template; `added` where the site has no file. */
  write: { path: string; added: boolean }[];
  /** Files of a replaced part that the template no longer has. */
  remove: string[];
  /** One line for each part kept although the template changed it. */
  kept: string[];
};

/** What a link or anything but a file counts as: a fingerprint no template file has. */
const OTHER = 'not a file';

/** The fingerprint of each of `paths` that is in the site, read with `print`. */
function present(root: string, paths: Iterable<string>, print: Scaffold['fingerprint']) {
  const found: Prints = {};
  for (const path of paths) {
    const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
    if (stat) found[path] = stat.isFile() ? print(readFileSync(join(root, path))) : OTHER;
  }
  return found;
}

/**
 * The fingerprint of every file in `folders`, as the course reader sees them: names that start
 * with a dot are skipped, and a link counts as no file of the template's.
 */
function inFolders(root: string, folders: string[], print: Scaffold['fingerprint']) {
  const found: Prints = {};
  const walk = (at: string): void => {
    const stat = lstatSync(join(root, at), { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isFile()) found[at] = print(readFileSync(join(root, at)));
    else if (!stat.isDirectory()) found[at] = OTHER;
    else
      for (const name of readdirSync(join(root, at))) {
        if (!name.startsWith('.')) walk(posix.join(at, name));
      }
  };
  for (const folder of folders) walk(folder);
  return found;
}

const same = (a: Prints, b: Prints) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};
const only = (prints: Prints, paths: Set<string>) =>
  Object.fromEntries(Object.entries(prints).filter(([path]) => paths.has(path)));
/** `a`, `a and b`, `a, b and c`. */
export const listed = (names: string[]) =>
  names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/**
 * Compares the site at `root` with `fresh`, the template of the tool's version, part by part.
 * `bases` are what the template gave the site: the record alone (`exact`), or for a site with no
 * record each published version's files. A part whose files in the site are one of the bases is
 * the template's, and is replaced; any other has changes of the author's and is kept, with a line
 * when the template changed it. A part the template does not have is left as it is.
 */
export function planUpdate(
  root: string,
  fresh: Prints,
  bases: Prints[],
  exact: boolean,
  print: Scaffold['fingerprint'],
): Plan {
  const parts = new Map<string, Part & { paths: Set<string> }>();
  for (const path of [...Object.keys(fresh), ...bases.flatMap(Object.keys)]) {
    const part = partOf(path);
    const key = `${part.kind}:${part.name}`;
    const known = parts.get(key) ?? { ...part, paths: new Set<string>() };
    parts.set(key, known);
    known.paths.add(path);
  }
  const plan: Plan = { write: [], remove: [], kept: [] };
  for (const part of parts.values()) {
    const next = only(fresh, part.paths);
    const files = Object.keys(next);
    if (files.length === 0) continue;
    const before = bases.map((base) => only(base, part.paths));
    // With the record, the template changed a file when its fingerprint there differs; without
    // it, what the site's version gave is unknown, so each file that differs is named.
    const changed = (path: string) => !exact || before[0]?.[path] !== next[path];
    const at = (path: string) => posix.join(TEMPLATE, path);
    if (part.kind === 'own') {
      // Only with the record is it known that the sample changed since the site took it.
      const site = present(root, files, print);
      const sample = (path: string) => exact && before[0]?.[path] !== undefined && changed(path);
      for (const path of files.filter((file) => site[file] !== next[file] && sample(file)))
        plan.kept.push(`${path} is yours and is kept; the template's sample changed: ${at(path)}`);
      continue;
    }
    const site =
      part.kind === 'course'
        ? inFolders(root, part.folders, print)
        : present(root, part.paths, print);
    if (same(site, next)) continue;
    const empty = Object.keys(site).length === 0;
    if (before.some((base) => same(site, base))) {
      // A sample course or front page that the site never had is not added.
      if (empty && part.kind !== 'file') continue;
      for (const path of files.filter((file) => site[file] !== next[file]))
        plan.write.push({ path, added: site[path] === undefined });
      plan.remove.push(...Object.keys(site).filter((path) => next[path] === undefined));
      continue;
    }
    const differ = files.filter((path) => site[path] !== next[path] && changed(path));
    if (differ.length === 0 || (empty && part.kind !== 'file')) continue;
    // Without the record what the template changed is unknown: the line says where to compare.
    const which =
      part.kind === 'file'
        ? 'it'
        : part.kind === 'pages'
          ? listed(differ.map((path) => path.slice('src/pages/'.length)))
          : `${differ.length} of its files`;
    const where = (part.kind === 'course' ? part.folders : [part.name]).map(at).join(' and ');
    const why = exact ? `the template changed ${which}: ${where}` : `compare with ${where}`;
    const what = empty ? 'is not in the site and is not added' : 'has changes of yours and is kept';
    plan.kept.push(`${part.name} ${what}; ${why}`);
  }
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  plan.write.sort((a, b) => order(a.path, b.path));
  plan.remove.sort(order);
  plan.kept.sort(order);
  return plan;
}

/** Copies the planned files from the laid-out template and removes the planned ones. */
function apply(root: string, plan: Plan): void {
  for (const { path } of plan.write) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(root, TEMPLATE, path), join(root, path));
  }
  for (const path of plan.remove) {
    rmSync(join(root, path));
    // Folders the removal left empty go too, up to the site folder.
    for (let dir = posix.dirname(path); dir !== '.'; dir = posix.dirname(dir)) {
      if (readdirSync(join(root, dir)).length > 0) break;
      rmdirSync(join(root, dir));
    }
  }
}

/** What `refresh` did, or with `dryRun` would do. */
export type Refreshed = Plan & { record: 'read' | 'none' | 'unreadable' };

/**
 * The site's files on the tool's version (docs/design/site.md §10.1): lays out the template of the
 * site's mode into `.parallax/template`, compares the site with it and, unless `dryRun`, writes
 * and removes what the plan names, then the record of the template's files.
 */
export async function refresh(root: string, mode: Mode, dryRun: boolean): Promise<Refreshed> {
  const scaffold = await loadSource<Scaffold>('scaffold', 'src/create.mjs');
  const dir = join(root, TEMPLATE);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  scaffold.lay(dir, mode);
  const fresh = scaffold.fingerprints(dir);
  let record: Refreshed['record'] = 'none';
  let recorded: Prints | undefined;
  try {
    const { files } = JSON.parse(readFileSync(join(root, scaffold.RECORD), 'utf8'));
    const valid = (value: unknown) => typeof value === 'string';
    const object = typeof files === 'object' && files !== null && !Array.isArray(files);
    if (!object || !Object.values(files).every(valid)) throw new Error('no files');
    [recorded, record] = [files, 'read'];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') record = 'unreadable';
  }
  const bases = recorded
    ? [recorded]
    : Object.values(published.versions).map((version) => version[mode]);
  const plan = planUpdate(root, fresh, bases, Boolean(recorded), scaffold.fingerprint);
  if (!dryRun) {
    apply(root, plan);
    scaffold.writeRecord(root, fresh);
  }
  return { ...plan, record };
}

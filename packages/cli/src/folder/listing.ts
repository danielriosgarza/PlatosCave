import * as fs from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { type Problem, refusal } from './yaml';

/** What a directory gives for one name; `target` is where a link leads, null where nowhere. */
export type Listed = { name: string; folder: boolean; target?: string | null };
/** An entry the reader goes on with: its name as the directory spells it, its path with `/`. */
export type Entry = { name: string; path: string; folder: boolean };
export type Listing = { entries: Entry[]; problems: Problem[] };

/** Whether two names differ in case and in nothing else. */
export const sameButCase = (a: string, b: string) => a !== b && a.toLowerCase() === b.toLowerCase();
const outside = (root: string, target: string) => {
  const from = relative(root, target);
  return from === '..' || from.startsWith(`..${sep}`) || isAbsolute(from);
};

/**
 * The entries of one folder that are read (docs/design/course-folder.md §2), sorted by name.
 * `root` is the folder being read, with its links resolved: the course folder for the tree, the
 * course's own folder for the overlay. `folder` is the listed folder's path from it. A name that
 * starts with `.` is skipped, and one that starts with `_` unless `underscore` is false. Refused,
 * each with its path: a link whose target lies outside the root, and two names that differ only
 * in case, which a file system that ignores case cannot hold and opens under either spelling.
 */
export function screen(listed: Listed[], root: string, folder: string, underscore = true): Listing {
  const at = (name: string) => (folder ? `${folder}/${name}` : name);
  const read = listed
    .filter(({ name }) => !name.startsWith('.') && !(underscore && name.startsWith('_')))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const listing: Listing = { entries: [], problems: [] };
  const refuse = (name: string, why: string) =>
    listing.problems.push(refusal('path', at(name), why));
  for (const { name, folder: isFolder, target } of read) {
    const twin = read.find((other) => sameButCase(other.name, name));
    if (target === null || (target !== undefined && outside(root, target))) {
      refuse(name, 'a link that leads out of the folder being read, or nowhere');
    } else if (twin) refuse(name, `differs only in case from ${at(twin.name)}`);
    else listing.entries.push({ name, path: at(name), folder: isFolder });
  }
  return listing;
}

const real = (path: string) => fs.realpathSync.native(path);

/** Reads one folder of the root from disk; `folder` is a path that a listing gave, or the root. */
export function listFolder(root: string, folder = '', underscore = true): Listing {
  const listed = fs.readdirSync(join(root, folder), { withFileTypes: true }).map((entry) => {
    const { name } = entry;
    if (!entry.isSymbolicLink()) return { name, folder: entry.isDirectory() };
    try {
      const target = real(join(root, folder, name));
      return { name, folder: fs.statSync(target).isDirectory(), target };
    } catch {
      return { name, folder: false, target: null };
    }
  });
  return screen(listed, real(root), folder, underscore);
}

/**
 * Every file under a folder that lies beside a notebook or a test (design §2), sorted by path, by
 * code unit. There a name that starts with `_` is an ordinary file. A link that stays inside the
 * root is followed, unless it leads back to a folder it lies in, which would have no end.
 */
export function walk(root: string, folder: string): { files: string[]; problems: Problem[] } {
  const files: string[] = [];
  const problems: Problem[] = [];
  const descend = (path: string, above: string[]) => {
    const here = real(join(root, path));
    if (above.includes(here)) {
      problems.push(refusal('path', path, 'a link that leads back to a folder it lies in'));
      return;
    }
    const listing = listFolder(root, path, false);
    problems.push(...listing.problems);
    for (const entry of listing.entries) {
      if (entry.folder) descend(entry.path, [...above, here]);
      else files.push(entry.path);
    }
  };
  descend(folder, []);
  return { files: files.sort(), problems };
}

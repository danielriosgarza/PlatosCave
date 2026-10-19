import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadSource, sourceRoot } from '../paths';
import { SiteProblems } from './load';

/** A page of the site: its file from the site folder, written with `/`, and its address. */
export type Page = { file: string; path: string };

/** The addresses the Parallax server answers itself (`apps/server/src/http/`), never a page's. */
const SERVED = ['api', 'assets', 'content'];
/** `/courses` and the addresses below it, kept at every level (docs/design/open-site.md §2). */
const { OPEN_ADDRESSES } = await loadSource<typeof import('@parallax/contracts')>(
  'contracts',
  'src/index.ts',
);
const segments = (address: string) => address.split('/').filter(Boolean);

/**
 * The address of every Parallax screen (docs/design/site.md §6.3): the keys of `FileRoutesByTo` in
 * the route tree that the router generates, where `$name` stands for any one segment. Throws when
 * none can be read, so that a change of the generator's form cannot switch the rule off.
 */
export function screenAddresses(tree = join(sourceRoot('web'), 'src/routeTree.gen.ts')): string[] {
  const text = readFileSync(tree, 'utf8');
  const block = /export interface FileRoutesByTo \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? '';
  const keys = [...block.matchAll(/^\s*'([^']+)':/gm)].map((match) => match[1] ?? '');
  if (keys.length === 0) throw new Error(`${tree}: no address in FileRoutesByTo, so no screen`);
  const odd = keys.flatMap(segments).find((part) => /[$*{}]/.test(part) && !/^\$\w+$/.test(part));
  if (odd !== undefined) throw new Error(`${tree}: the screen segment ${odd} cannot be compared`);
  return keys;
}

/** The screen at whose address a page with these segments would be, if any. */
const screenAt = (parts: string[], screens: string[]) =>
  screens.find((screen) => {
    const want = segments(screen.toLowerCase());
    const same = (part: string, i: number) => part.startsWith('$') || part === parts[i];
    return want.length === parts.length && want.every(same);
  });

/**
 * The pages under `src/pages` and their addresses (docs/design/site.md §6.2): `index.tsx` is `/`,
 * `team/index.tsx` is `/team`; a name that starts with `_` is a helper. Throws `SiteProblems`, one
 * line each, for a Markdown file, a segment other than lower-case letters, digits and hyphens, two
 * files at one address, a page at a screen's address (§6.3) other than `/` or under an address
 * the server answers itself, and one at an address of `OPEN_ADDRESSES`, at every level (open-site
 * design §2), all before anything is written.
 */
export function findPages(root: string, screens = screenAddresses()): Page[] {
  const dir = join(root, 'src/pages');
  const entries = existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }) : [];
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .sort();
  const pages: Page[] = [];
  const problems: string[] = [];
  for (const name of files) {
    const file = `src/pages/${name}`;
    const page = /^(.*)\.[jt]sx$/.exec(name)?.[1];
    if (/\.mdx?$/i.test(name)) problems.push(`${file}: a page is a .tsx or .jsx, not Markdown`);
    if (page === undefined || name.split('/').some((part) => part.startsWith('_'))) continue;
    const parts = segments(page);
    if (parts.at(-1) === 'index') parts.pop();
    const bad = parts.find((part) => !/^[a-z0-9-]+$/.test(part));
    if (bad !== undefined) {
      problems.push(`${file}: "${bad}" cannot be part of an address: use a-z, 0-9 and -`);
      continue;
    }
    const path = `/${parts.join('/')}`;
    const screen = path === '/' ? undefined : screenAt(parts, screens);
    const kept = screenAt(parts, [...OPEN_ADDRESSES]);
    const at = `${file} would be at ${path}`;
    if (screen) {
      problems.push(
        `${at}, the address of the Parallax screen ${screen}. A site adds pages and cannot replace a Parallax screen: move or rename the page.`,
      );
    } else if (kept) {
      problems.push(
        `${at}, which matches ${kept}: Parallax keeps /courses and the addresses below it. Move or rename the page.`,
      );
    } else if (SERVED.includes(parts[0] ?? '')) {
      problems.push(`${at}, under /${parts[0]}, which the Parallax server answers itself.`);
    }
    const twin = pages.find((other) => other.path === path);
    if (twin) problems.push(`${twin.file} and ${file} are both at ${path}: keep one of them.`);
    pages.push({ file, path });
  }
  if (problems.length > 0) throw new SiteProblems(problems);
  return pages;
}

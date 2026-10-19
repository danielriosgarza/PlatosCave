import fs from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The packing of docs/design/site.md §2. It imports Node's own modules only, because it runs as the
// `prepack` of a copy that scripts/pack.ts stages outside the repository, where nothing is installed.

/** Each source by its folder in `vendor/` and in the repository, as `src/paths.ts` lays them out. */
export const SOURCES = {
  web: 'apps/web',
  ui: 'packages/ui',
  contracts: 'packages/contracts',
  server: 'apps/server',
  deploy: 'scripts',
} as const;
type Name = keyof typeof SOURCES;

/** Of the server, the conversion entry (P5-09) and the publication checks, with what they import. */
const SERVER = ['src/content/convert.ts', 'src/content/validation.ts'];
/** Of `scripts/`, the backup and its restore (§10). */
const DEPLOY = ['backup.sh', 'restore.sh'];
/** What is no source: tests and their helpers and fixtures, dot files, installed or built output. */
const NOT_SOURCE =
  /(^|\/)(\.[^/]*|node_modules|dist|coverage|test|fixtures|fixtures\.ts)(\/|$)|\.(test|itest|e2e|spec)\.[cm]?[jt]sx?$/;
const CODE = /\.([cm]?[jt]sx?|css)$/;

/**
 * The module specifiers of a file: of `import … from`, `export … from`, `import` (CSS `@import`
 * too), `import()` and `new URL()`, each `from` and plain `import` only where a statement starts,
 * so not in a string. `type` marks those the compiler erases: `import type`, `export type` and
 * `typeof import()`.
 */
const SPECIFIER = /(?<![\w$.'"])(typeof\s+)?(from|import\s*\(?|new URL\s*\()\s*(['"])([^'"\n]+)\3/g;
const STATEMENT = /(?:^|[;\n])\s*(?:import|export)\b(\s+type\b)?[^;'"`]*$/;
const STARTS = /(?:^|[;\n{])\s*@?$/;
export function specifiers(code: string): { spec: string; type: boolean }[] {
  return [...code.matchAll(SPECIFIER)].flatMap((match) => {
    const before = code.slice(0, match.index);
    const statement = match[2] === 'from' ? STATEMENT.exec(before) : undefined;
    if (statement === null || (match[2] === 'import' && !STARTS.test(before))) return [];
    return [{ spec: match[4] ?? '', type: Boolean(match[1] || statement?.[1]) }];
  });
}

/** The file a relative specifier of the file `from` names, as tsx and Vite find it, with `/`. */
export function relativeTarget(isFile: (path: string) => boolean, from: string, spec: string) {
  const base = posix.join(posix.dirname(from), spec.replace(/\?.*$/, ''));
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(isFile);
}

/** The files of a folder that are sources, from it, with `/`; skipped folders are not entered. */
function sources(root: string, at = ''): string[] {
  return fs.readdirSync(join(root, at), { withFileTypes: true }).flatMap((entry) => {
    const path = at ? `${at}/${entry.name}` : entry.name;
    if (NOT_SOURCE.test(path)) return [];
    return entry.isDirectory() ? sources(root, path) : entry.isFile() ? [path] : [];
  });
}

/** The files of the server that the entries reach through relative imports and thread scripts. */
export function closure(server: string): string[] {
  const isFile = (path: string) =>
    fs.statSync(join(server, path), { throwIfNoEntry: false })?.isFile() === true;
  const seen = new Set<string>();
  const follow = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    for (const { spec } of specifiers(fs.readFileSync(join(server, path), 'utf8'))) {
      if (!spec.startsWith('.')) continue;
      const found = relativeTarget(isFile, path, spec);
      if (!found) throw new Error(`apps/server/${path} imports ${spec}, which is no file`);
      follow(found);
    }
  };
  for (const entry of SERVER) follow(entry);
  return [...seen];
}

/** The copy of `@parallax/<package>[/<subpath>]` under `vendor/`, through that package's `exports`. */
function workspaceFile(repository: string, spec: string): string {
  for (const [name, dir] of Object.entries(SOURCES)) {
    const file = join(repository, dir, 'package.json');
    const manifest = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const own = manifest.name;
    if (typeof own !== 'string' || (spec !== own && !spec.startsWith(`${own}/`))) continue;
    const subpath = `.${spec.slice(own.length)}`;
    for (const [pattern, to] of Object.entries<string>(manifest.exports ?? {})) {
      const [head = '', tail = ''] = pattern.split('*');
      const star = pattern.includes('*');
      if (star ? !subpath.startsWith(head) || !subpath.endsWith(tail) : subpath !== pattern)
        continue;
      const matched = subpath.slice(head.length, subpath.length - tail.length);
      return posix.join('vendor', name, star ? to.replace('*', matched) : to);
    }
  }
  throw new Error(`${spec} is not a path that a workspace package exports`);
}

/**
 * Lays out the sources in `target/vendor/{web,ui,contracts,server,deploy}`, puts
 * `tsconfig.base.json` at `target`, which their `tsconfig.json` extend, and turns each
 * `@parallax/…` specifier of the copies and of the tool's own `src/` and `bin/` into a relative path.
 */
export function vendor(target: string, repository: string): void {
  const inRepository = relative(repository, target);
  if (!inRepository.startsWith('..') && !isAbsolute(inRepository)) {
    throw new Error(
      `vendor.ts writes into a staged copy only, not into ${target}: run scripts/pack.ts`,
    );
  }
  const out = join(target, 'vendor');
  fs.rmSync(out, { recursive: true, force: true });
  const from = (name: Name) => join(repository, SOURCES[name]);
  const lists: Record<Name, string[]> = {
    web: sources(from('web')),
    ui: sources(from('ui')),
    contracts: sources(from('contracts')),
    server: closure(from('server')),
    deploy: DEPLOY,
  };
  const written: string[] = [];
  for (const [name, list] of Object.entries(lists) as [Name, string[]][]) {
    for (const path of list) {
      fs.mkdirSync(dirname(join(out, name, path)), { recursive: true });
      fs.copyFileSync(join(from(name), path), join(out, name, path));
      written.push(posix.join('vendor', name, path));
    }
  }
  fs.copyFileSync(join(repository, 'tsconfig.base.json'), join(target, 'tsconfig.base.json'));
  const own = ['src', 'bin'].filter((dir) => fs.existsSync(join(target, dir)));
  const tool = own.flatMap((dir) => sources(join(target, dir)).map((path) => `${dir}/${path}`));
  for (const path of [...written, ...tool].filter((file) => CODE.test(file))) {
    const code = fs.readFileSync(join(target, path), 'utf8');
    const rewritten = code.replace(SPECIFIER, (match, _type, _kind, quote, spec: string) => {
      if (!spec.startsWith('@parallax/')) return match;
      const file = workspaceFile(repository, spec);
      if (!fs.existsSync(join(target, file)))
        throw new Error(`${path}: ${spec} is not in the copy`);
      const to = posix.relative(posix.dirname(path), file);
      return match.replace(
        `${quote}${spec}${quote}`,
        `${quote}${to.startsWith('.') ? to : `./${to}`}${quote}`,
      );
    });
    if (rewritten !== code) fs.writeFileSync(join(target, path), rewritten);
  }
}

// As `prepack` (`tsx scripts/vendor.ts`) in the copy that pack.ts stages and names the repository for.
const self = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ?? '';
if (fs.existsSync(invoked) && fs.realpathSync(invoked) === fs.realpathSync(self)) {
  const repository = process.env.PARALLAX_REPOSITORY;
  if (repository) vendor(resolve(dirname(self), '..'), repository);
  else {
    console.error(
      'vendor.ts runs in a staged copy: pack with scripts/pack.ts <package> <version> <folder>',
    );
    process.exitCode = 1;
  }
}

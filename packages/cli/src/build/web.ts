import fs from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { build, createLogger, type InlineConfig, type Plugin } from 'vite';
import { packageRoot, sourceRoot } from '../paths';
import { catalogue } from '../site/folders';
import { type Site, SiteProblems } from '../site/load';
import { findPages, type Page } from '../site/pages';
import { STYLESHEET, stylesheetProblems } from './styles';

/** The sources copied into the work tree, under these names (docs/design/site.md §2, §6.4). */
const COPIED = ['web', 'ui', 'contracts'] as const;
/** The packages a page shares with the application, so that the site has one copy of each. */
const SHARED = /^(react|react-dom|@tanstack\/react-(router|query))(\/|$)/;
const slash = (path: string) => path.replaceAll('\\', '/');
/** A module id without its query, written with `/`. */
const file = (id: string) => slash(id.replace(/\?.*$/, ''));
const MAIN = 'src="/src/main.tsx"';
const ENTRY = 'src="/src/site-entry.gen.tsx"';
/** The course folders of both modes, which move between the modes unchanged, and the overlay. */
const HIDDEN = /^(courses|private|instructors\/[^/]+\/courses)(\/|$)/i;

// Vite reads some files without asking a plugin: the asset of a `new URL(…, import.meta.url)` or
// of a stylesheet's `url()`, and the stylesheet of an `@import` or a `composes`. So Node's reads
// ask `reading` while `compile` runs Vite's build, and at no other time: not in `parallax dev`, and
// not while the catalogue reads `course.yaml`. They are wrapped once, as postcss-modules keeps what
// it found.
let reading: ((path: string) => void) | undefined;
let building = false;
for (const at of [fs, fs.promises]) {
  for (const name of ['readFile', 'readFileSync'].filter((name) => name in at)) {
    const read = Reflect.get(at, name);
    Reflect.set(at, name, (...args: unknown[]) => {
      if (building) reading?.(String(args[0]));
      return Reflect.apply(read, at, args);
    });
  }
}

/** Where a site's build lives (§3), absolute and from the site folder's real path. */
export function buildPaths(site: string) {
  const root = fs.realpathSync.native(site);
  const own = join(root, '.parallax');
  return { root, app: join(own, 'app'), web: join(own, 'app/web'), out: join(own, 'dist') };
}
type Paths = ReturnType<typeof buildPaths>;

/** The plugins of `apps/web/vite.config.ts`, in order; the router's temporary files in `tmpDir`. */
export const webPlugins = (tmpDir: string) => [
  tanstackRouter({ target: 'react', autoCodeSplitting: true, tmpDir }),
  react(),
];

/**
 * Steps 1 and 2 of §6.4: the sources copied into `.parallax/app/` (in a packed tool only for a new
 * version), the page list with the props of §6.6, the entry that mounts the app, and `index.html`.
 */
function prepare(site: Site, paths: Paths, pages: Page[]): void {
  const { version } = JSON.parse(fs.readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const marker = join(paths.app, 'version');
  const packed = fs.existsSync(join(packageRoot, 'vendor'));
  if (!packed || !fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== version) {
    fs.rmSync(paths.app, { recursive: true, force: true });
    const filter = (from: string) => !/[\\/](node_modules|dist|\.tanstack)$/.test(from);
    for (const name of COPIED) {
      fs.cpSync(sourceRoot(name), join(paths.app, name), { recursive: true, filter });
    }
    // Their tsconfig.json extend ../../tsconfig.base.json, which therefore lies there in the copy.
    const base = 'tsconfig.base.json';
    fs.cpSync(join(sourceRoot('web'), '../..', base), join(paths.app, '..', base));
    fs.writeFileSync(marker, version);
  }
  const src = join(paths.web, 'src');
  const from = (path: string) => JSON.stringify(slash(relative(src, join(paths.root, path))));
  const { name, logo } = site.config;
  const list = pages.map((p) => `\n  { path: '${p.path}', load: () => import(${from(p.file)}) },`);
  const shown = logo ? `logo: { src: logo, alt: ${JSON.stringify(logo.alt)} }, ` : '';
  const props = `{ site: { name: ${JSON.stringify(name)}, ${shown}entry: '/courses' }, catalogue };`;
  const lines = [
    '// Written by parallax build from the site; do not edit.',
    logo ? `import logo from ${from(logo.file)};` : '',
    `export const pages = [${list.join('')}\n];`,
    `const catalogue = ${JSON.stringify(catalogue(site))};`,
    `export const props = ${props}`,
  ];
  fs.writeFileSync(join(src, 'site-pages.gen.ts'), `${lines.join('\n')}\n`);
  const entry = `import { mount } from './app';\nimport { pages, props } from './site-pages.gen';\n
mount(document.getElementById('root') as HTMLElement, { pages, props });\n`;
  fs.writeFileSync(join(src, 'site-entry.gen.tsx'), entry);
  const html = fs.readFileSync(join(sourceRoot('web'), 'index.html'), 'utf8');
  if (!html.includes(MAIN)) throw new Error(`index.html of the web sources has no ${MAIN}`);
  fs.writeFileSync(join(paths.web, 'index.html'), html.replace(MAIN, ENTRY));
}

/** The real paths of the course folders, the overlay and each link in them, in lower case. */
export function hiddenTrees(root: string): string[] {
  const real = new Set<string>();
  const below = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) visit(join(dir, entry.name));
      else if (entry.isDirectory()) below(join(dir, entry.name));
    }
  };
  const visit = (path: string): void => {
    const at = fs.existsSync(path) ? fs.realpathSync.native(path) : undefined;
    if (at === undefined || real.has(at)) return;
    real.add(at);
    if (fs.statSync(at).isDirectory()) below(at);
  };
  const instructors = join(root, 'instructors');
  const listed = fs.existsSync(instructors) ? fs.readdirSync(instructors) : [];
  const tops = ['courses', 'private', ...listed.map((name) => `instructors/${name}/courses`)];
  for (const top of tops) visit(join(root, top));
  return [...real].map((path) => slash(path).toLowerCase());
}

/**
 * The resolver of §6.4: a bare import of the work tree as from the file's original place, taken
 * from the copy; the shared packages from the web sources; `parallax-site/pages` as the copy of
 * `sitePages.tsx`. A file in a course folder or the private overlay, by its path in the site or
 * where it really lies, stops the build when a module imports it, the bundle holds it or Node reads
 * it while the build runs (`reading`, while `compile` builds). So does a stylesheet that breaks the
 * rule of §6.7, the site's own or one a file of the site imports. Each refusal goes into `refused`.
 */
function sitePlugin(paths: Paths, refused: string[]): Plugin {
  const root = slash(paths.root);
  const sources = COPIED.map((name) => ({
    from: slash(fs.realpathSync.native(sourceRoot(name))),
    copy: `${root}/.parallax/app/${name}`,
  }));
  const swap = (path: string, a: 'from' | 'copy', b: 'from' | 'copy') => {
    const source = sources.find((each) => path.startsWith(`${each[a]}/`));
    return source && `${source[b]}${path.slice(source[a].length)}`;
  };
  /** A file of the site's own, from the site folder; not one of the tool's or of a package. */
  const own = (id: string) => {
    const path = slash(resolve(paths.web, file(id)));
    const ours = path.startsWith(`${root}/`) && !path.startsWith(`${root}/.parallax/`);
    return ours && !path.includes('/node_modules/') ? path.slice(root.length + 1) : undefined;
  };
  const named = (id: string) => own(id) ?? file(id);
  const trees = hiddenTrees(paths.root);
  /** Stops the build with `<what> <file>, which lies …` when `id` lies in one of them. */
  const check = (what: string, id: string) => {
    const path = `${slash(resolve(paths.web, file(id))).toLowerCase()}/`;
    if (!trees.some((tree) => path.startsWith(`${tree}/`)) && !HIDDEN.test(own(id) ?? '')) return;
    const line = `${what} ${named(id)}, which lies in a course folder or the private overlay: a site's pages cannot use course material.`;
    refused.push(line);
    throw new Error(line);
  };
  reading = (path) => check('The build would read', path);
  /** The stylesheets that files of the site import, a package's included. */
  const styles = new Set<string>();
  return {
    name: 'parallax:site',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (source === 'parallax-site/pages') return `${root}/.parallax/app/web/src/sitePages.tsx`;
      if (!importer) return null;
      const bare = /^(@[\w.-]+\/)?[a-z0-9][\w.-]*(\/|\?|$)/i.test(source) && !source.includes(':');
      const shared = bare && SHARED.test(source) && `${sources[0]?.from}/src/main.tsx`;
      const at = shared || (bare && swap(file(importer), 'copy', 'from')) || importer;
      const resolved = await this.resolve(source, at, { ...options, skipSelf: true });
      if (!resolved || resolved.external) return resolved;
      check(`${named(importer)} imports`, resolved.id);
      if (own(importer) && STYLESHEET.test(file(resolved.id))) styles.add(file(resolved.id));
      const query = resolved.id.slice(file(resolved.id).length);
      const copy = swap(file(resolved.id), 'from', 'copy');
      return copy ? { ...resolved, id: copy + query } : resolved;
    },
    transform(css, id) {
      // Not a `?raw` or `?url` import, which loads as a string and is not applied.
      const sheet = STYLESHEET.test(file(id)) && !/[?&](raw|url)\b/.test(id);
      if (!sheet || (!own(id) && !styles.has(file(id)))) return null;
      const problems = stylesheetProblems(own(id) ?? slash(relative(root, file(id))), css);
      refused.push(...problems);
      if (problems[0]) throw new Error(problems[0]);
      return null;
    },
    generateBundle(_, bundle) {
      // A refused read that Vite went on after (the asset of a `new URL`) stops the build here.
      if (refused[0]) throw new Error(refused[0]);
      for (const output of Object.values(bundle)) {
        const ids = output.type === 'chunk' ? output.moduleIds : output.originalFileNames;
        for (const id of ids) check('The build would hold', id);
      }
    },
  };
}

/** The Vite configuration of the site, its pages found and the work tree prepared (§6.4). */
export function viteConfig(site: Site, refused: string[] = []): InlineConfig {
  const paths = buildPaths(site.root);
  prepare(site, paths, findPages(paths.root));
  const cacheDir = join(paths.root, '.parallax/vite');
  const log = createLogger('warn');
  return {
    configFile: false,
    envDir: false,
    root: paths.web,
    publicDir: false,
    cacheDir,
    // Warnings only, none after a refusal; the command prints each error once, so not Vite's.
    logLevel: 'warn',
    customLogger: { ...log, error: () => {}, warnOnce: (m) => refused.length || log.warnOnce(m) },
    plugins: [sitePlugin(paths, refused), ...webPlugins(join(cacheDir, 'tanstack'))],
    worker: { plugins: () => [sitePlugin(paths, refused)] },
    // Each file emitted, none inlined, so the final check sees it; no maps, which publish sources.
    build: { outDir: paths.out, emptyOutDir: true, sourcemap: false, assetsInlineLimit: 0 },
  };
}

/** Steps 1 to 3 of §6.4, the compile into `.parallax/dist`; a refusal stops it as one line. */
export async function compile(site: Site): Promise<void> {
  const refused: string[] = [];
  const config = viteConfig(site, refused);
  // A site is always built for production; Vite sets this only where it is unset.
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    building = true;
    await build(config);
  } catch (error) {
    throw refused.length > 0 ? new SiteProblems(refused) : error;
  } finally {
    building = false;
    reading = undefined;
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
}

/**
 * Step 4 of §6.4, the compile put into `dist/`: each file by a temporary file renamed in place,
 * `index.html` last, then the files of an earlier build removed. The folder stays (§6.5).
 */
export function place(site: string): void {
  const { root, out } = buildPaths(site);
  const dist = join(root, 'dist');
  const files = (dir: string) =>
    (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }) : [])
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
  const fresh = files(out).sort((a, b) => Number(a === 'index.html') - Number(b === 'index.html'));
  if (fresh.at(-1) !== 'index.html') throw new Error('.parallax/dist holds no compiled site');
  for (const name of fresh) {
    const target = join(dist, name);
    fs.mkdirSync(dirname(target), { recursive: true });
    fs.cpSync(join(out, name), `${target}.${process.pid}.tmp`);
    fs.renameSync(`${target}.${process.pid}.tmp`, target);
  }
  for (const name of files(dist)) if (!fresh.includes(name)) fs.rmSync(join(dist, name));
}

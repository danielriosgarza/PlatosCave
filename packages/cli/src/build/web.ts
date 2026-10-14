import * as fs from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { build, createLogger, type InlineConfig, type Plugin } from 'vite';
import { packageRoot, sourceRoot } from '../paths';
import { type Site, SiteProblems } from '../site/load';
import { findPages, type Page } from '../site/pages';

/** The sources copied into the work tree, under these names (docs/design/site.md §2, §6.4). */
const COPIED = ['web', 'ui', 'contracts'] as const;
/** The packages a page shares with the application, so that the site has one copy of each. */
const SHARED = /^(react|react-dom|@tanstack\/react-(router|query))(\/|$)/;
const slash = (path: string) => path.replaceAll('\\', '/');
/** A module id without its query, written with `/`. */
const file = (id: string) => slash(id.replace(/\?.*$/, ''));
const MAIN = 'src="/src/main.tsx"';
/** The course folders of both modes, which move between the modes unchanged, and the overlay. */
const HIDDEN = /^(courses|private|instructors\/[^/]+\/courses)(\/|$)/i;

/** Where a site's build lives (§3), absolute and from the site folder's real path. */
export function buildPaths(site: string) {
  const root = fs.realpathSync.native(site);
  const own = join(root, '.parallax');
  return { root, app: join(own, 'app'), web: join(own, 'app/web'), out: join(own, 'dist') };
}
type Paths = ReturnType<typeof buildPaths>;

/**
 * The plugins of `apps/web/vite.config.ts`, in its order. The router keeps its temporary files in
 * `tmpDir`, which would otherwise be `.tanstack/` in the working directory.
 */
export const webPlugins = (tmpDir: string) => [
  tanstackRouter({ target: 'react', autoCodeSplitting: true, tmpDir }),
  react(),
];

/**
 * Steps 1 and 2 of §6.4: the sources copied into `.parallax/app/` (in a packed tool only when the
 * copy is of another version; in the repository they change under one version), then the page
 * list with the props of §6.6, the entry that mounts the application with them, and `index.html`.
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
  const list = pages.map(
    (page) => `\n  { path: '${page.path}', load: () => import(${from(page.file)}) },`,
  );
  const shown = logo ? `logo: { src: logo, alt: ${JSON.stringify(logo.alt)} }, ` : '';
  // The catalogue of §6.6 stays empty until `src/site/folders.ts` builds it.
  const props = `{ site: { name: ${JSON.stringify(name)}, ${shown}entry: '/courses' }, catalogue };`;
  const lines = [
    '// Written by parallax build from the site; do not edit.',
    logo ? `import logo from ${from(logo.file)};` : '',
    `export const pages = [${list.join('')}\n];`,
    `const catalogue = ${JSON.stringify({ instructors: [] })};`,
    `export const props = ${props}`,
  ];
  fs.writeFileSync(join(src, 'site-pages.gen.ts'), `${lines.join('\n')}\n`);
  const entry = `import { mount } from './app';\nimport { pages, props } from './site-pages.gen';\n
mount(document.getElementById('root') as HTMLElement, { pages, props });\n`;
  fs.writeFileSync(join(src, 'site-entry.gen.tsx'), entry);
  const html = fs.readFileSync(join(sourceRoot('web'), 'index.html'), 'utf8');
  if (!html.includes(MAIN)) throw new Error(`index.html of the web sources has no ${MAIN}`);
  fs.writeFileSync(
    join(paths.web, 'index.html'),
    html.replace(MAIN, 'src="/src/site-entry.gen.tsx"'),
  );
}

/**
 * Where the course folders of both modes and the overlay really lie, in lower case: each one and
 * the target of every link in it, so a link counts where it leads. Only listings are read.
 */
function hiddenTrees(root: string): string[] {
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
 * `sitePages.tsx`. Whatever lies in a course folder or the private overlay, by its path in the
 * site or where it really lies, stops the build; each refusal is also put into `refused`.
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
  const trees = hiddenTrees(paths.root);
  /** In a course folder or the overlay, by its path in the site or where it really lies. */
  const hidden = (id: string) => {
    const path = slash(resolve(paths.web, file(id))).toLowerCase();
    const inTree = trees.some((tree) => path === tree || path.startsWith(`${tree}/`));
    return inTree || HIDDEN.test(own(id) ?? '');
  };
  const named = (id: string) => own(id) ?? file(id);
  const refuse = (what: string) => {
    const line = `${what}, which lies in a course folder or the private overlay: a site's pages cannot use course material.`;
    refused.push(line);
    return line;
  };
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
      if (hidden(resolved.id))
        this.error(refuse(`${named(importer)} imports ${named(resolved.id)}`));
      const query = resolved.id.slice(file(resolved.id).length);
      const copy = swap(file(resolved.id), 'from', 'copy');
      return copy ? { ...resolved, id: copy + query } : resolved;
    },
    generateBundle(_, bundle) {
      for (const output of Object.values(bundle)) {
        const ids = output.type === 'chunk' ? output.moduleIds : output.originalFileNames;
        const found = ids.find(hidden);
        if (found) this.error(refuse(`The build would hold ${named(found)}`));
      }
    },
  };
}

/** The Vite configuration of the site, its pages found and the work tree prepared (§6.4). */
export function viteConfig(site: Site, refused: string[] = []): InlineConfig {
  const paths = buildPaths(site.root);
  prepare(site, paths, findPages(paths.root));
  const cacheDir = join(paths.root, '.parallax/vite');
  return {
    configFile: false,
    envDir: false,
    root: paths.web,
    publicDir: false,
    cacheDir,
    // Warnings only; the command prints each error once, so Vite's own error line is dropped.
    logLevel: 'warn',
    customLogger: { ...createLogger('warn'), error: () => {} },
    plugins: [sitePlugin(paths, refused), ...webPlugins(join(cacheDir, 'tanstack'))],
    // No source maps: they would publish the sources of the site's pages beside the bundle.
    build: { outDir: paths.out, emptyOutDir: true, sourcemap: false, reportCompressedSize: false },
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
    await build(config);
  } catch (error) {
    throw refused.length > 0 ? new SiteProblems(refused) : error;
  } finally {
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

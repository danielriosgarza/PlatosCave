import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin, PluginOption } from 'vite';
import { afterAll, expect, test, vi } from 'vitest';
import { webPlugins } from './build/web';
import { devServer } from './commands/dev';
import { main } from './main';
import { loadSite } from './site/load';

const pkg = resolve(import.meta.dirname, '..');
const repo = resolve(pkg, '../..');
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-a37-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
delete process.env.DATABASE_URL;

/** Every file under `dir`, from it, with `/`; a `node_modules` folder is listed, not entered. */
const files = (dir: string): string[] =>
  (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }) : [])
    .filter((entry) => entry.isFile() || entry.name === 'node_modules')
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .sort();
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const web = join(repo, 'apps/web/src');
/** The hashes of the repository's route files and of its generated route tree. */
const routes = () =>
  [...files(join(web, 'routes')), '../routeTree.gen.ts'].map((f) => hash(join(web, 'routes', f)));
/** The names of a list of Vite plugins, nested lists flattened in order. */
const names = async (plugins: PluginOption[]): Promise<string[]> => {
  const all = (await Promise.all(plugins)).flat(9) as (Plugin | false | null | undefined)[];
  return all.flatMap((plugin) => (plugin ? [plugin.name] : []));
};

test('A37 a site builds with its front page at / beside the Parallax screens', {
  timeout: 600_000,
}, async () => {
  const site = join(temp, 'school');
  fs.cpSync(join(pkg, 'fixtures/site/school'), site, { recursive: true });
  fs.writeFileSync(join(site, 'src/pages/about.tsx'), 'export default () => <p>About us</p>;\n');
  const own = () => files(site).filter((file) => !/^(\.parallax|dist)\//.test(file));
  // Where Vite and the router write by default: a cache under node_modules, and `.tanstack/`.
  const caches = ['apps/web', 'packages/cli'].map((dir) => join(repo, dir, 'node_modules/.vite'));
  const written = () => [...caches, join(process.cwd(), '.tanstack')].map(files);
  const before = { site: own(), routes: routes(), written: written() };
  vi.spyOn(console, 'error').mockImplementation(() => {});

  expect(await main(['build'], { cwd: site })).toBe(0);
  const dist = join(site, 'dist');
  const first = files(dist);
  const scripts = first.filter((file) => file.endsWith('.js'));
  const text = scripts.map((file) => fs.readFileSync(join(dist, file), 'utf8')).join('\n');
  expect(first).toContain('index.html');
  expect(text).toContain('Courses at ');
  expect(text).toMatch(/\{\s*path:\s*["'`]\/["'`],\s*load:/);
  expect(scripts.some((file) => /^assets\/signin-[\w-]+\.js$/.test(file))).toBe(true);
  // Nothing of the course folders, the overlay or the instructors' addresses is in the site.
  for (const output of first) {
    const content = fs.readFileSync(join(dist, output), 'latin1');
    expect(content).not.toMatch(/sentinel-(course-file|hidden-definition|address)/);
  }
  // The catalogue lists the instructors, then their courses, with names and titles only; a course
  // without a course.yaml has its folder's name as its title.
  const gen = fs.readFileSync(join(site, '.parallax/app/web/src/site-pages.gen.ts'), 'utf8');
  const reef = { slug: 'reef-ecology', title: 'Reef ecology' };
  const statistics = { slug: 'statistics', title: 'statistics' };
  expect(JSON.parse(/^const catalogue = (.*);$/m.exec(gen)?.[1] ?? '')).toEqual({
    instructors: [
      { slug: 'ana', name: 'Ana Example', courses: [reef] },
      { slug: 'ben', name: 'Ben Example', courses: [statistics] },
    ],
  });
  // The build used the plugins of the web application and wrote only into .parallax/ and dist/.
  const config = await import(pathToFileURL(join(repo, 'apps/web/vite.config.ts')).href);
  expect(await names(webPlugins(temp))).toEqual(await names(config.default.plugins));
  expect({ site: own(), routes: routes(), written: written() }).toEqual(before);
  expect(files(site).filter((file) => file.includes('node_modules'))).toEqual([]);

  // A second build after a page was removed leaves no file of the first one in dist/.
  fs.rmSync(join(site, 'src/pages/about.tsx'));
  expect(await main(['build'], { cwd: site })).toBe(0);
  const second = files(dist);
  expect(second).toEqual(files(join(site, '.parallax/dist')));
  expect(first.filter((file) => file.startsWith('assets/about-'))).toHaveLength(1);
  expect(second.filter((file) => file.startsWith('assets/about-'))).toEqual([]);
});

test('parallax dev serves the pages and the logo, and no file of a course folder or the overlay', {
  timeout: 300_000,
}, async () => {
  const root = join(temp, 'dev');
  fs.cpSync(join(pkg, 'fixtures/site/instructor'), root, { recursive: true });
  // A link in src/, a folder the server serves, to a course folder.
  fs.symlinkSync(join(root, 'courses/statistics'), join(root, 'src/linked'), 'junction');
  const server = await devServer(await loadSite(root), 0);
  try {
    // The build's check of Node's reads is armed by `compile` alone, so the server leaves it off.
    expect(() =>
      fs.readFileSync(join(root, 'courses/statistics/means/reading/means.md')),
    ).not.toThrow();
    await server.listen();
    const base = server.resolvedUrls?.local[0] ?? '';
    const real = fs.realpathSync.native(root).replaceAll('\\', '/');
    const status = async (path: string) => (await fetch(new URL(path, base))).status;
    expect(await status('/')).toBe(200);
    expect(await status(`/@fs/${real}/src/pages/index.tsx`)).toBe(200);
    expect(await status(`/@fs/${real}/src/logo.png`)).toBe(200);
    expect(await status(`/@fs/${real}/courses/statistics/means/reading/means.md`)).toBe(403);
    expect(await status(`/@fs/${real}/private/courses/statistics/means/exercises/mean.yaml`)).toBe(
      403,
    );
    expect(await status(`/@fs/${real}/src/linked/means/reading/means.md`)).toBe(403);
  } finally {
    await server.close();
  }
});

test('parallax --help lists the commands, and a command module without run is named', async () => {
  const lines: string[] = [];
  const print = (line: string) => void lines.push(line);
  expect(await main(['--help'], { print })).toBe(0);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toBe('usage: parallax <command>');
  const listed = lines[1]?.replace(/^Commands: /, '').split(', ');
  expect(listed).toEqual(expect.arrayContaining(['build', 'check', 'dev']));
  // On the standard output, and after a command too, which then does not run.
  const cwd = join(pkg, 'fixtures/site/instructor');
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await main(['dev', '--help'], { cwd })).toBe(0);
  expect(out.mock.calls.map(([line]) => line)).toEqual(lines.slice(0, 2));
  out.mockRestore();
  const commands = join(temp, 'commands');
  fs.mkdirSync(commands);
  fs.writeFileSync(join(commands, 'broken.ts'), 'export const value = 1;\n');
  expect(await main(['broken'], { cwd, commands, print })).toBe(1);
  expect(lines.at(-1)).toBe('parallax: the module of the command broken exports no run function');
});

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin, PluginOption } from 'vite';
import { afterAll, expect, test, vi } from 'vitest';
import { webPlugins } from './build/web';
import { main } from './main';

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
  [...files(join(web, 'routes')), '../routeTree.gen.ts'].map((file) =>
    hash(join(web, 'routes', file)),
  );
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

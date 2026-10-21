import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { pack } from '../../packages/cli/scripts/pack';
import config from '../playwright.config';
import { small } from '../touch';

// The operator's steps (docs/design/site.md §3, §5, §10) on packed tarballs. Nothing is published,
// so a tarball's file: address stands where an operator has the version number of parallax-site.
const repo = resolve(import.meta.dirname, '../..');
const versions = ['0.0.1-a37.1', '0.0.2-a37.2'] as const;
const base = 'http://127.0.0.1:3117';
const name = 'My Parallax site';
const { DATABASE_URL: _, ...operator } = process.env;
// On Windows npm and npx are command scripts, which only a shell can start.
const shell = process.platform === 'win32';
let temp = '';
let site = '';
let tarballs: string[] = [];
let modules: string[] = [];
let server: ChildProcess | undefined;

/** A command of the operator's, in the site folder by default. */
const run = (command: string, args: string[], cwd = site) =>
  execFileSync(command, args, { cwd, env: operator, stdio: 'pipe', shell, timeout: 300_000 });
const read = (file: string) => fs.readFileSync(join(site, file), 'utf8');
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
/** Writes `tarball`'s address where the site's package.json has the version of parallax-site. */
function depend(tarball = ''): void {
  const manifest = JSON.parse(read('package.json'));
  manifest.dependencies['parallax-site'] = `file:${tarball.replaceAll('\\', '/')}`;
  fs.writeFileSync(join(site, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}
const listing = () =>
  fs.readdirSync(join(site, 'node_modules'), { recursive: true }).map(String).sort();
/** The hash of each file that the site's .gitignore does not exclude, by its path. */
const tracked = (): Record<string, string> =>
  Object.fromEntries(
    run('git', ['ls-files', '-z', '--others', '--exclude-standard'])
      .toString()
      .split('\0')
      .filter(Boolean)
      .map((file) => [file, hash(join(site, file))]),
  );

test.use({ baseURL: base });

test.beforeAll(async () => {
  test.setTimeout(540_000);
  temp = fs.mkdtempSync(join(tmpdir(), 'parallax-a37-e2e-'));
  site = join(temp, 'site');
  tarballs = versions.map((version) => pack('parallax-site', version, temp));
  // npm create installs the scaffolder and runs it; here from its own packed tarball.
  const scaffolder = pack('create-parallax-site', versions[0], temp);
  run('npm', ['install', '--prefix', join(temp, 'create'), '--no-package-lock', scaffolder], temp);
  const bin = join(temp, 'create/node_modules/create-parallax-site/bin/create-parallax-site.mjs');
  execFileSync(process.execPath, [bin, 'site'], { cwd: temp, stdio: 'pipe' });
  expect(JSON.parse(read('package.json')).dependencies).toEqual({ 'parallax-site': versions[0] });
  // The operator adds a logo: the file, and the line of parallax.config.ts that names it.
  const logo = join(repo, 'packages/cli/fixtures/site/instructor/src/logo.png');
  fs.copyFileSync(logo, join(site, 'src/logo.png'));
  fs.writeFileSync(
    join(site, 'parallax.config.ts'),
    read('parallax.config.ts').replace('// logo:', 'logo:'),
  );
  depend(tarballs[0]);
  run('npm', ['install', '--no-audit', '--no-fund']);
  modules = listing();
  run('npx', ['parallax', 'build']);
  // A second server process beside the suite's own, serving the site's dist/ (§6.5). Nothing may
  // answer on its port before it starts, so the server that answers is this one.
  const health = async () => (await fetch(`${base}/api/health`).catch(() => null))?.status;
  expect(await health(), 'a process already answers on port 3117').toBeUndefined();
  const { env } = config.webServer as { env: Record<string, string> };
  server = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', 'api'], {
    cwd: join(repo, 'apps/server'),
    stdio: 'ignore',
    env: {
      ...process.env,
      ...env,
      PORT: '3117',
      APP_ORIGIN: base,
      CONTENT_ORIGIN: 'http://localhost:3117',
      STATIC_DIR: join(site, 'dist'),
    },
  });
  await expect.poll(health, { timeout: 60_000 }).toBe(200);
});

test.afterAll(() => {
  server?.kill();
  if (temp) fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
});

test('A37 a site created from the instructor template shows its front page at / and links to the Parallax interface', async ({
  page,
  browser,
}) => {
  const response = await page.goto('/');
  expect(response?.headers()['content-security-policy']).toContain("img-src 'self'");
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name })).toBeVisible();
  const logo = main.getByRole('img', { name });
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  const src = await logo.getAttribute('src');
  expect(src).toMatch(/^\/assets\/logo-[\w-]+\.png$/);
  await expect(main.getByRole('heading', { level: 2 })).toHaveText(['Courses', 'Make it yours']);
  // The course catalogue: one card per course, with its instructor.
  const courses = main.getByRole('region', { name: 'Courses' }).getByRole('listitem');
  await expect(courses).toHaveCount(1);
  await expect(courses.getByRole('heading', { level: 3 })).toHaveText('Welcome to Parallax');
  await expect(courses).toContainText('Alex Example');
  // The scene under the title draws on a canvas, and a button stops and starts it.
  await expect(main.getByRole('img', { name: /^Plato's cave/ })).toBeVisible();
  await main.getByRole('button', { name: 'Pause animation' }).click();
  await expect(main.getByRole('button', { name: 'Play animation' })).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations).toEqual([]);
  // On a touch screen every control of the page is a target of at least 44 px (DESIGN.md, A20).
  const touch = await browser.newPage({ baseURL: base, hasTouch: true, isMobile: true });
  await touch.goto('/');
  await expect(touch.getByRole('link', { name: 'Open the courses' })).toBeVisible();
  expect(await small(touch, 'main a, main button')).toEqual([]);
  await touch.close();

  const link = main.getByRole('link');
  await expect(link).toHaveText(['Open the courses']);
  expect(await link.getAttribute('href')).toBe('/courses');
  await link.click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/signin');
  await page.goto('/signin');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('img', { name })).toHaveCount(0);
  await expect(page.locator(`img[src="${src}"]`)).toHaveCount(0);
  expect(listing()).toEqual(modules);
});

test('A37 a new version changes package.json and no other tracked file', async () => {
  test.setTimeout(300_000);
  run('git', ['init', '-q']);
  const before = tracked();
  const kept = ['.gitignore', '.npmrc', 'package.json', 'parallax.config.ts', 'src/logo.png'];
  expect(Object.keys(before)).toEqual(expect.arrayContaining(kept));
  depend(tarballs[1]);
  run('npm', ['install', '--no-audit', '--no-fund']);
  run('npx', ['parallax', 'build']);
  const after = tracked();
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  const changed = Object.keys(after).filter((file) => after[file] !== before[file]);
  expect(changed).toEqual(['package.json']);
  const locks = ['package-lock.json', 'npm-shrinkwrap.json'];
  expect(locks.filter((lock) => fs.existsSync(join(site, lock)))).toEqual([]);
  // The new version is the one installed, and the one the site was built with.
  expect(JSON.parse(read('node_modules/parallax-site/package.json')).version).toBe(versions[1]);
  expect(read('.parallax/app/version')).toBe(versions[1]);
});

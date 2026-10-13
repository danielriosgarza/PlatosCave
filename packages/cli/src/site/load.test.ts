import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { main } from '../main';
import { loadSite, SiteProblems } from './load';

const pkg = resolve(import.meta.dirname, '../..');
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-site-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
delete process.env.DATABASE_URL;
const file = 'parallax.config.ts';

function write(root: string, path: string, text: string): void {
  fs.mkdirSync(join(root, path, '..'), { recursive: true });
  fs.writeFileSync(join(root, path), text);
}
let copies = 0;
/** A fixture site copied outside the repository, with files written over it and one edit. */
function site(fixture: string, files: Record<string, string> = {}, edit = ['', '']): string {
  const root = join(temp, `site-${copies++}`);
  fs.cpSync(join(pkg, 'fixtures/config', fixture), root, { recursive: true });
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  const config = fs.readFileSync(join(root, file), 'utf8');
  write(root, file, config.replace(edit[0] ?? '', edit[1] ?? ''));
  return root;
}

describe('loadSite', () => {
  test('the fixture configurations load with DATABASE_URL deleted from the environment', async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
    const root = join(pkg, 'fixtures/config/instructor');
    const one = await loadSite(root);
    expect(one).toMatchObject({ root, config: { mode: 'instructor', instructors: ['.'] } });
    expect(one.config.classes.map((cls) => cls.open)).toEqual([false, true]);
    // The school site from a folder outside the repository: `parallax-site` is installed nowhere.
    const { config } = await loadSite(site('school'));
    expect(config).toMatchObject({ mode: 'school', level: 2, instructors: ['ana', 'ben'] });
    expect(config.runner?.runtimes.map((runtime) => runtime.id)).toEqual(['python-3.12']);
    expect(config.classes.map((cls) => cls.instructors)).toEqual([['ana', 'ben'], ['ben']]);
  });

  test('a site without "type": "module" loads from the package installed beside it', async () => {
    const stub = { 'node_modules/parallax-site/index.js': 'exports.defineConfig = (c) => c;' };
    const { config } = await loadSite(site('instructor', { 'package.json': '{}', ...stub }));
    expect(config.name).toBe('Statistics for Biologists');
  });

  test('a configuration that cannot be used stops the load, one line for each problem', async () => {
    const lines = (root: string) => loadSite(root).catch((error: SiteProblems) => error.lines);
    const refused = site('school', {}, ['level: 2,', "level: 3, theme: 'dark',"]);
    const level = expect.stringMatching(/^parallax\.config\.ts: level: /);
    expect(await lines(refused)).toEqual([level, `${file}: theme: unknown key`]);
    // A file that does not compile is reported with the place and the reason of each error.
    const broken = site('instructor', { [file]: 'export default {' });
    const reason = /^parallax\.config\.ts: .+:1:16: ERROR: Expected .+ but found end of file$/;
    expect(await lines(broken)).toEqual([expect.stringMatching(reason)]);
    const named = site('instructor', {}, ['export default', 'export const config =']);
    expect(await lines(named)).toEqual([`${file}: the configuration is not the default export`]);
    expect(await lines(temp)).toEqual([`${file}: not found in ${temp}`]);
    await expect(loadSite(temp)).rejects.toBeInstanceOf(SiteProblems);
  });
});

describe('parallax', () => {
  const commands = join(temp, 'commands');
  const run = 'export const run = async ({ site, args }) => site.config.level + 10 * args.length;';
  // Command modules are ES modules, as the tool's own package is.
  write(commands, 'package.json', '{ "type": "module" }');
  for (const name of ['build', 'dev', 'dev.test', 'types.d']) write(commands, `${name}.ts`, run);
  const node = (...args: string[]) =>
    spawnSync(process.execPath, args, { cwd: pkg, encoding: 'utf8', timeout: 20000 });

  test('an unknown command lists the commands', async () => {
    const printed: string[] = [];
    expect(await main(['deploy'], { commands, print: (line) => printed.push(line) })).toBe(1);
    expect(printed).toEqual(['parallax: unknown command deploy', 'Commands: build, dev']);
    const ran = node(join(pkg, 'bin/parallax.mjs'), 'deploy');
    expect([ran.status, ran.stdout]).toEqual([1, '']);
    expect(ran.stderr).toMatch(/^parallax: unknown command deploy\nCommands: .+\n$/);
  });

  test('a command runs in the loaded site, and a refused configuration stops before it', async () => {
    const printed: string[] = [];
    const options = { commands, print: (line: string) => printed.push(line) };
    expect(await main(['build', 'a', 'b'], { ...options, cwd: site('school') })).toBe(22);
    expect(printed).toEqual([]);
    const refused = site('school', {}, ['level: 2,', 'level: 2, theme: 0,']);
    expect(await main(['build'], { ...options, cwd: refused })).toBe(1);
    expect(printed).toEqual([`${file}: theme: unknown key`]);
  });

  test('started as bin/parallax.mjs starts it, the tool loads a site outside the repository', () => {
    const entry = pathToFileURL(join(pkg, 'src/main.ts')).href;
    const options = JSON.stringify({ commands, cwd: site('school') });
    const script = `import { register } from 'tsx/esm/api';
      register();
      const { main } = await import(${JSON.stringify(entry)});
      process.exitCode = await main(['build'], ${options});`;
    const ran = node('--input-type=module', '-e', script);
    expect([ran.stderr, ran.status]).toEqual(['', 2]);
  });
});

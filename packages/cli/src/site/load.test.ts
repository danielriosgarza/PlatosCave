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
type Change = (root: string) => void;
const remove =
  (path: string): Change =>
  (root) =>
    fs.rmSync(join(root, path), { recursive: true });
const move =
  (from: string, to: string): Change =>
  (root) =>
    fs.renameSync(join(root, from), join(root, to));
/** A junction on Windows and a symbolic link elsewhere, at `at` in the site, to `target`. */
const link =
  (target: string, at: string): Change =>
  (root) =>
    fs.symlinkSync(resolve(root, target), join(root, at), 'junction');
function changed(root: string, ...changes: Change[]): string {
  for (const change of changes) change(root);
  return root;
}
/** The lines a site's load stops with, none when it loads. */
const problems = (root: string): Promise<string[]> =>
  loadSite(root).then(
    () => [],
    (error: unknown) => (error instanceof SiteProblems ? error.lines : Promise.reject(error)),
  );
const ben = 'instructors/ben';
/** An edit after which the configuration throws on its line 5. */
const threw = ["name: 'Statistics", "name: undefined!.trim() + '"];

describe('loadSite', () => {
  test('the fixture configurations load with DATABASE_URL deleted from the environment', async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
    const root = join(pkg, 'fixtures/config/instructor');
    const one = await loadSite(root);
    expect(one).toMatchObject({ root, config: { mode: 'instructor', instructors: ['.'] } });
    expect(one.config.classes.map((cls) => cls.open)).toEqual([false, true]);
    const ana = { name: 'Ana Example', email: 'ana@example.org' };
    expect(one.instructors).toEqual([{ ref: '.', path: '.', meta: ana, courses: ['statistics'] }]);
    // The school site from a folder outside the repository: `parallax-site` is installed nowhere.
    const { config, instructors } = await loadSite(site('school'));
    expect(config).toMatchObject({ mode: 'school', level: 2, instructors: ['ana', 'ben'] });
    expect(config.runner?.runtimes.map((runtime) => runtime.id)).toEqual(['python-3.12']);
    expect(config.classes.map((cls) => cls.instructors)).toEqual([['ana', 'ben'], ['ben']]);
    expect(instructors.map(({ ref, path, meta, courses }) => [ref, path, meta, courses])).toEqual([
      ['ana', 'instructors/ana', ana, ['reef-ecology']],
      ['ben', ben, { name: 'Ben Example', email: 'ben@example.org' }, ['statistics']],
    ]);
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

  test('an error the configuration throws, or a default export that is no object, is one line', async () => {
    // The error's name and message, and its first place in a file of the site folder. The tool's
    // own process maps the place to the TypeScript line; this one's test runner does not.
    const place =
      /^parallax\.config\.ts: TypeError: Cannot read .+, at parallax\.config\.ts:\d+:\d+$/;
    expect(await problems(site('instructor', {}, threw))).toEqual([expect.stringMatching(place)]);
    // A throw inside an installed package names the configuration's line that called it.
    const foo = {
      'node_modules/foo/index.js': "exports.f = () => { throw new TypeError('in foo') };",
    };
    const call = site('instructor', foo, [
      'export default',
      "import { f } from 'foo';\nf();\nexport default",
    ]);
    const called = /^parallax\.config\.ts: TypeError: in foo, at parallax\.config\.ts:\d+:\d+$/;
    expect(await problems(call)).toEqual([expect.stringMatching(called)]);
    const empty = site('instructor', { [file]: 'throw new Error();' });
    const bare = /^parallax\.config\.ts: Error, at parallax\.config\.ts:\d+:\d+$/;
    expect(await problems(empty)).toEqual([expect.stringMatching(bare)]);
    const object = `${file}: the default export must be the object that defineConfig returns`;
    for (const value of ['() => ({})', 'Promise.resolve({})', "'instructor'"]) {
      const root = site('instructor', { [file]: `export default ${value};` });
      expect(await problems(root), value).toEqual([object]);
    }
  });

  test('a problem in the folder stops the load, one line for each, with the path named', async () => {
    const yaml = { [`${ben}/instructor.yaml`]: 'name: Ben Example\nemail: ben\nrole: admin\n' };
    const twice = { [`${ben}/instructor.yaml`]: 'name: Ben\nemail: ben@example.org\nname: B\n' };
    const cases: [string, string[]][] = [
      [
        changed(site('school'), remove(`${ben}/courses/statistics`)),
        [`${file}: classes[1].course: no folder ${ben}/courses/statistics`],
      ],
      [
        changed(site('instructor'), remove('instructor.yaml'), remove('src/logo.png')),
        ['instructor.yaml: not found', `${file}: logo.file: no file src/logo.png`],
      ],
      [
        site('school', { 'instructors/carl/courses/.gitkeep': '', 'instructors/.git/x': '' }),
        [`instructors/carl: the folder is not in instructors of ${file}`],
      ],
      [changed(site('school'), remove(ben)), [`${file}: instructors[1]: no folder ${ben}`]],
      [changed(site('school'), remove(`${ben}/courses`)), [`${ben}/courses: not found`]],
      [changed(site('instructor'), remove('courses')), ['courses: not found']],
      [
        site('school', yaml),
        [
          `${ben}/instructor.yaml: email: Invalid email address`,
          `${ben}/instructor.yaml: role: unknown key`,
        ],
      ],
      [site('school', twice), [`${ben}/instructor.yaml: line 3: this key stands twice in one map`]],
      // A class of a refused instructor folder adds no line of its own.
      [
        changed(
          site('school'),
          remove(`${ben}/instructor.yaml`),
          remove(`${ben}/courses/statistics`),
        ),
        [`${ben}/instructor.yaml: not found`],
      ],
      [
        changed(site('school'), remove('instructors')),
        [
          `${file}: instructors[0]: no folder instructors/ana`,
          `${file}: instructors[1]: no folder ${ben}`,
        ],
      ],
      // An entry that cannot be read, here a link to itself, is a line and not an exception.
      [changed(site('instructor'), link('loop', 'loop')), ['loop: cannot be read (ELOOP)']],
    ];
    for (const [root, lines] of cases) expect(await problems(root), lines[0]).toEqual(lines);
  });

  test('a name that differs from the listing only in case or Unicode form is refused with both', async () => {
    // On Windows and macOS the folder opens under either spelling: only the listing tells them apart.
    const reef = 'instructors/ana/courses/reef-ecology';
    const disk = (on: string, here: string) =>
      `the name on disk is ${on}, not ${here} (case or Unicode form)`;
    const cased = changed(site('school'), move(reef, 'instructors/ana/courses/Reef-Ecology'));
    expect(await problems(cased)).toEqual([
      `${file}: classes[0].course: ${disk('Reef-Ecology', 'reef-ecology')}`,
    ]);
    // One name in two Unicode forms: e followed by a combining accent, and the one letter.
    const formed = site('school', {}, ['ana/reef-ecology', 'ana/caf\u00e9']);
    changed(formed, move(reef, 'instructors/ana/courses/cafe\u0301'));
    // A name not in NFC is written with code points, so that the two forms read apart.
    const escaped = disk('cafe\\u{301}', 'caf\u00e9');
    expect(await problems(formed)).toEqual([`${file}: classes[0].course: ${escaped}`]);
    // The class of the refused folder adds no line, and the folder on disk is not called unlisted.
    const named = changed(site('school'), move('instructors/ana', 'instructors/Ana'));
    expect(await problems(named)).toEqual([`${file}: instructors[0]: ${disk('Ana', 'ana')}`]);
    // A listed folder whose twin in the other form lies beside it: the twin is not listed.
    const twin = (name: string, email: string) => ({
      [`instructors/${name}/instructor.yaml`]: `name: Caf\nemail: ${email}\n`,
      [`instructors/${name}/courses/.gitkeep`]: '',
    });
    const twins = site(
      'school',
      { ...twin('caf\u00e9', 'nfc@example.org'), ...twin('cafe\u0301', 'nfd@example.org') },
      ["instructors: ['ana', 'ben'],", "instructors: ['ana', 'ben', 'caf\u00e9'],"],
    );
    const unlisted = `instructors/cafe\\u{301}: the folder is not in instructors of ${file}`;
    expect(await problems(twins)).toEqual([unlisted]);
  });

  test('two instructor folders with one address are refused, naming both files and no address', async () => {
    const yaml = { [`${ben}/instructor.yaml`]: 'name: Ben Example\nemail: Ana@Example.ORG\n' };
    const lines = await problems(site('school', yaml));
    expect(lines).toEqual([
      `${ben}/instructor.yaml: email: the same address as instructors/ana/instructor.yaml`,
    ]);
    expect(lines.join('\n')).not.toMatch(/@|example\.org/i);
    // A valid address counts although another key of its file is wrong: both lines in one run.
    const ana = 'instructors/ana/instructor.yaml';
    const both = { ...yaml, [ana]: 'name: Ana Example\nemail: ana@example.org\nrole: admin\n' };
    expect(await problems(site('school', both))).toEqual([
      `${ana}: role: unknown key`,
      `${ben}/instructor.yaml: email: the same address as ${ana}`,
    ]);
  });

  test('the logo is checked by its real path: inside the site, outside course folders and private/', async () => {
    write(temp, 'elsewhere/logo.png', '');
    // Written into the configuration as a string, so a backslash stays one.
    const logo = (path: string, files: Record<string, string> = {}, ...changes: Change[]) =>
      problems(
        changed(
          site('instructor', files, ['src/logo.png', JSON.stringify(path).slice(1, -1)]),
          ...changes,
        ),
      );
    const at = (path: string, why: string) => [`${file}: logo.file: ${path} ${why}`];
    const shape = 'is not a path inside the site folder, written with / and without .. or :';
    for (const path of [
      '/logo.png',
      'C:/logo.png',
      '../x.png',
      'src/../src/logo.png',
      'src\\logo.png',
    ]) {
      expect(await logo(path), path).toEqual(at(path, shape));
    }
    expect(await logo('https://example.org/x.png')).toEqual(at('https://example.org/x.png', shape));
    // A control character is refused with the others, and printed as its code point.
    expect(await logo('src/a\u0000.png')).toEqual(at('src/a\\u{0}.png', shape));
    // Decided from the listing, as a course's name: a host that tells case apart would not open it.
    const cased = 'SRC/logo.png: the name on disk is src, not SRC (case or Unicode form)';
    expect(await logo('SRC/logo.png')).toEqual([`${file}: logo.file: ${cased}`]);
    const out = link(join(temp, 'elsewhere'), 'src/out');
    expect(await logo('src/out/logo.png', {}, out)).toEqual(
      at('src/out/logo.png', 'lies outside the site folder'),
    );
    const material = 'lies in a course folder or the private overlay';
    const course = { 'courses/statistics/logo.png': '' };
    expect(await logo('courses/statistics/logo.png', course)).toEqual(
      at('courses/statistics/logo.png', material),
    );
    expect(await logo('private/logo.png', { 'private/logo.png': '' })).toEqual(
      at('private/logo.png', material),
    );
    const into = link('courses/statistics', 'src/in');
    expect(await logo('src/in/logo.png', course, into)).toEqual(at('src/in/logo.png', material));
    const school = `instructors/ana/courses/reef-ecology/logo.png`;
    const edit = ['level: 2,', `level: 2, logo: { file: '${school}', alt: 'Logo' },`];
    expect(await problems(site('school', { [school]: '' }, edit))).toEqual(at(school, material));
    expect(await logo('instructors/x/logo.png', { 'instructors/x/logo.png': '' })).toEqual([]);
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

  test('a command runs in the loaded site, and a refused configuration or folder stops before it', async () => {
    const printed: string[] = [];
    const options = { commands, print: (line: string) => printed.push(line) };
    expect(await main(['build', 'a', 'b'], { ...options, cwd: site('school') })).toBe(22);
    expect(printed).toEqual([]);
    const refused = site('school', {}, ['level: 2,', 'level: 2, theme: 0,']);
    expect(await main(['build'], { ...options, cwd: refused })).toBe(1);
    expect(printed).toEqual([`${file}: theme: unknown key`]);
    const folder = changed(site('school'), remove(`${ben}/courses/statistics`));
    expect(await main(['build'], { ...options, cwd: folder })).toBe(1);
    expect(printed.slice(1)).toEqual([
      `${file}: classes[1].course: no folder ${ben}/courses/statistics`,
    ]);
  });

  /** `parallax build` in a site, in a process started as `bin/parallax.mjs` starts the tool. */
  function asTool(cwd: string) {
    const entry = pathToFileURL(join(pkg, 'src/main.ts')).href;
    const options = JSON.stringify({ commands, cwd });
    const script = `import { register } from 'tsx/esm/api';
      register();
      const { main } = await import(${JSON.stringify(entry)});
      process.exitCode = await main(['build'], ${options});`;
    return node('--input-type=module', '-e', script);
  }

  test('started as bin/parallax.mjs starts it, the tool loads a site outside the repository', () => {
    const ran = asTool(site('school'));
    expect([ran.stderr, ran.status]).toEqual(['', 2]);
  });

  test('started so, the tool names the line of the configuration that threw', () => {
    const ran = asTool(site('instructor', {}, threw));
    const line =
      /^parallax\.config\.ts: TypeError: Cannot read .+, at parallax\.config\.ts:5:\d+\n$/;
    expect([ran.stderr, ran.status]).toEqual([expect.stringMatching(line), 1]);
  });
});

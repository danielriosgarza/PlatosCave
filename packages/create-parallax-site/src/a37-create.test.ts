import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, expect, test, vi } from 'vitest';
import { main } from '../../cli/src/main';
import { loadSite } from '../../cli/src/site/load';
import { create } from './create.mjs';

const pkg = resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-a37-create-'));
afterAll(() => {
  vi.restoreAllMocks();
  fs.rmSync(temp, { recursive: true, force: true });
});
delete process.env.DATABASE_URL;

/** Every file under `dir`, from it, with `/`. */
const files = (dir: string): string[] =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .sort();
const read = (dir: string, file: string) => fs.readFileSync(join(dir, file), 'utf8');
const ignored = ['node_modules/', '.env', '.parallax/', 'dist/', 'backups/', 'private/'];
/** Each instructor's name with the titles of their courses, as the front page lists them. */
const listed = {
  instructor: [['Alex Example', ['Welcome to Parallax']]],
  school: [
    ['Ana Example', ['Reef Ecology', 'Welcome to Parallax']],
    ['Ben Example', ['Field Statistics']],
  ],
};

test('A37 one command creates a site of either mode, and only package.json names the Parallax version', {
  timeout: 600_000,
}, async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const lines: string[] = [];
  const print = (line: string) => void lines.push(line);
  const said = () => [...lines, ...error.mock.calls, ...log.mock.calls].join('\n');
  const [version, refused] = ['3.1.4-a37', 'is not empty. Name a new or empty folder.'];
  for (const template of ['instructor', 'school'] as const) {
    const site = join(temp, template);
    expect(create([site, `--template=${template}`], { version, print })).toBe(0);
    const made = files(site);
    // A second run into the same folder is refused and changes nothing.
    expect(create([site, '--template', template], { version, print })).toBe(1);
    expect(lines.at(-1)).toBe(`create-parallax-site: ${site} ${refused}`);
    expect(files(site)).toEqual(made);
    // npm delivers no .gitignore or .npmrc in a package: the templates hold them as _gitignore
    // and _npmrc, and _gitattributes beside them, and the site gets them under their real names.
    expect(made).toEqual(expect.arrayContaining(['.gitattributes', 'src/pages/index.tsx']));
    // The starter course, with its exercise and test in the overlay at the same path.
    const welcome = `${template === 'school' ? 'instructors/ana/' : ''}courses/welcome/start-here`;
    expect(made).toEqual(
      expect.arrayContaining([
        `${welcome}/topic.yaml`,
        `${welcome}/notebooks/demo/data/heights.csv`,
        `private/${welcome}/exercises/first-exercise.yaml`,
        `private/${welcome}/tests/sample-test.yaml`,
      ]),
    );
    expect(made.filter((file) => /^_(gitignore|npmrc|gitattributes)$/.test(file))).toEqual([]);
    expect(read(site, '.npmrc')).toBe('package-lock=false\n');
    expect(read(site, '.gitattributes')).toBe('* text=auto eol=lf\n');
    expect(read(site, '.gitignore').split('\n')).toEqual(expect.arrayContaining(ignored));
    const manifest = JSON.parse(read(site, 'package.json'));
    const dependencies = { 'parallax-site': version };
    expect(manifest).toEqual({ private: true, type: 'module', dependencies });
    expect(made.filter((file) => read(site, file).includes(version))).toEqual(['package.json']);

    expect((await loadSite(site)).config.mode).toBe(template);
    // The awaited code comes first, so the message holds what the commands printed.
    expect(await main(['check'], { cwd: site, print }), said()).toBe(0);
    expect(await main(['build'], { cwd: site, print }), said()).toBe(0);
    const dist = join(site, 'dist');
    const scripts = files(dist).filter((file) => file.endsWith('.js'));
    const text = scripts.map((file) => read(dist, file)).join('\n');
    expect(files(dist)).toContain('index.html');
    expect(text).toMatch(/\{\s*path:\s*["'`]\/["'`],\s*load:/);
    expect(text).toContain('Browse courses');
    const gen = read(site, '.parallax/app/web/src/site-pages.gen.ts');
    const { instructors } = JSON.parse(/^const catalogue = (.*);$/m.exec(gen)?.[1] ?? '{}');
    const shown = instructors.map((one: { name: string; courses: { title: string }[] }) => [
      one.name,
      one.courses.map((course) => course.title),
    ]);
    expect(shown).toEqual(listed[template]);
  }
  // By default the site names the scaffolder's own version, and an empty folder is taken.
  const empty = join(temp, 'empty');
  fs.mkdirSync(empty);
  expect(create(['.'], { cwd: empty, print })).toBe(0);
  expect(lines.at(-1)).toBe('Created . from the instructor template. Next: npm install.');
  const own = JSON.parse(read(pkg, 'package.json')).version;
  expect(JSON.parse(read(empty, 'package.json')).dependencies).toEqual({ 'parallax-site': own });
  expect((await loadSite(empty)).config.mode).toBe('instructor');
  expect(create([join(temp, 'other'), '--template', 'course'], { print })).toBe(2);
  expect(fs.existsSync(join(temp, 'other'))).toBe(false);
  expect(create(['--help'], { print })).toBe(0);
  expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/^usage: npm create parallax-site /));
  // A folder that cannot be written is named in one line, and nothing is left behind.
  fs.writeFileSync(join(temp, 'file'), '');
  expect(create([join(temp, 'file', 'site')], { print })).toBe(1);
  expect(lines.at(-1)).toMatch(/file[\\/]site could not be written \(E[A-Z]+\)\.$/);

  // The templates hold no secret, only references to one, and every exercise and test definition
  // lies in the starter course's overlay, which the site's .gitignore lists (private/ above).
  const templates = join(pkg, 'templates');
  const all = files(templates);
  // Each line that grep -rniE "(password|secret|token)\s*[:=]" prints names a ${VAR} reference.
  const named = /(password|secret|token)\s*[:=]\s*(["']?\$\{\w)?/i;
  const rows = all.flatMap((file) => read(templates, file).split('\n'));
  expect(rows.filter((row) => named.test(row) && !named.exec(row)?.[2])).toEqual([]);
  const definitions = all.filter((file) => /(^|\/)(exercises|tests|private)\//.test(file));
  expect(definitions.length).toBeGreaterThan(0);
  expect(definitions.filter((file) => !file.startsWith('instructor/private/courses/'))).toEqual([]);
});

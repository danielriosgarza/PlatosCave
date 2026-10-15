import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { readCourseForSync } from './read';

delete process.env.DATABASE_URL;
const fixture = resolve(import.meta.dirname, '../../fixtures/course');
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-read-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
const course = 'courses/reef-ecology';
let sites = 0;
/** A copy of the fixture site, changed by `change`. */
function copy(change: (site: string) => void): string {
  const site = join(temp, `site-${sites++}`);
  fs.cpSync(fixture, site, { recursive: true });
  change(site);
  return site;
}
const read = (site: string, dir = course) =>
  readCourseForSync(join(site, dir), { overlay: join(site, 'private', course) });

test('a topic without a tests/ folder reads as a topic with no test, and .gitkeep in a tab folder is skipped', async () => {
  const tides = join(fixture, course, 'tides');
  expect(fs.readdirSync(join(tides, 'slides'))).toEqual(['.gitkeep']);
  expect(fs.existsSync(join(tides, 'tests'))).toBe(false);
  const { manifest, problems } = await read(fixture);
  expect(problems).toEqual([]);
  expect(manifest?.topics[0]?.resources.map((r) => r.type)).toEqual(['reading_native']);
});

test('links out of the course folder, names in another case and file-system errors stop the reader', async () => {
  const [reading, tests] = [`${course}/sampling/reading`, `private/${course}/sampling/tests`];
  const link = (site: string, target: string, name: string) =>
    fs.symlinkSync(target, join(site, reading, name), 'junction');
  const rename = (site: string, folder: string, from: string, to: string) =>
    fs.renameSync(join(site, folder, from), join(site, folder, to));
  // A function of node:fs that fails for one path, as a denied permission does; restored below.
  type Call = (path: unknown, ...rest: unknown[]) => unknown;
  const writable = fs as unknown as Record<string, Call>;
  const real = { lstatSync: writable.lstatSync, readFileSync: writable.readFileSync };
  const deny = (name: keyof typeof real, ...path: string[]) => {
    writable[name] = (at, ...rest) => {
      if (resolve(String(at)) === join(...path)) throw Object.assign(Error(), { code: 'EACCES' });
      return real[name]?.(at, ...rest);
    };
    syncBuiltinESMExports();
  };
  const changes: [path: string, change: (site: string) => void, overlay?: true][] = [
    ['sampling/reading/out', (site) => link(site, site, 'out')],
    ['sampling/reading/quiz', (site) => link(site, join(site, 'private', course), 'quiz')],
    ['sampling/topic.yaml', (site) => rename(site, reading, 'methods.md', 'Methods.md')],
    // The folder of a test, spelled in another case, is the folder of no test.
    ['sampling/tests/Quiz/q3/main.py', (site) => rename(site, tests, 'quiz', 'Quiz'), true],
    ['', (site) => deny('lstatSync', site, course)],
    ['', (site) => deny('lstatSync', site, 'private', course), true],
    ['sampling/tests/quiz.yaml', (site) => deny('readFileSync', site, tests, 'quiz.yaml'), true],
  ];
  for (const [path, change, overlay] of changes) {
    const { manifest, problems } = await read(copy(change));
    Object.assign(writable, real);
    syncBuiltinESMExports();
    expect(manifest).toBeNull();
    const named = { severity: 'error', path, ...(overlay && { overlay }) };
    expect(problems).toContainEqual(expect.objectContaining(named));
  }
  // The course folder itself: a link to it, and a spelling the listing does not have.
  const linked = copy((site) => link(site, join(site, course), '../../../reef'));
  const named = [expect.objectContaining({ severity: 'error', path: '' })];
  expect((await read(linked, 'courses/reef')).problems).toEqual(named);
  expect((await read(fixture, 'courses/Reef-Ecology')).problems).toEqual(named);
});

test('without private/, a course declared public stops the reader with the paths it expected', async () => {
  const site = copy((dir) => fs.rmSync(join(dir, 'private'), { recursive: true }));
  const { manifest, problems } = await read(site);
  expect(manifest).toBeNull();
  const absent = { severity: 'error', overlay: true, message: 'no definition here' };
  const paths = ['sampling/exercises/estimate.yaml', 'sampling/tests/quiz.yaml'];
  expect(problems).toEqual(paths.map((path) => expect.objectContaining({ ...absent, path })));
});

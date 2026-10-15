import * as fs from 'node:fs';
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
  expect(manifest?.topics[0]?.resources.map((resource) => resource.type)).toEqual([
    'reading_native',
  ]);
});

test('a link out of the course folder or into private/, and a name in another case, stop the reader', async () => {
  const [reading, tests] = [`${course}/sampling/reading`, `private/${course}/sampling/tests`];
  const link = (site: string, target: string, name: string) =>
    fs.symlinkSync(target, join(site, reading, name), 'junction');
  const rename = (site: string, from: string, to: string) =>
    fs.renameSync(join(site, from), join(site, to));
  const changes: [path: string, change: (site: string) => void][] = [
    ['sampling/reading/out', (site) => link(site, site, 'out')],
    ['sampling/reading/quiz', (site) => link(site, join(site, 'private', course), 'quiz')],
    [
      'sampling/topic.yaml',
      (site) => rename(site, `${reading}/methods.md`, `${reading}/Methods.md`),
    ],
    // The folder of a test, spelled in another case, is the folder of no test.
    ['sampling/tests/Quiz/q3/main.py', (site) => rename(site, `${tests}/quiz`, `${tests}/Quiz`)],
    // The course folder itself: a link to it, and a spelling the listing does not have.
    ['', (site) => link(site, join(site, course), '../../../reef')],
  ];
  for (const [path, change] of changes) {
    const site = copy(change);
    const { manifest, problems } = await read(site, path ? course : 'courses/reef');
    expect(manifest).toBeNull();
    expect(problems).toContainEqual(expect.objectContaining({ severity: 'error', path }));
  }
  const { problems } = await read(fixture, 'courses/Reef-Ecology');
  expect(problems).toEqual([expect.objectContaining({ severity: 'error', path: '' })]);
});

test('without private/, a course declared public stops the reader with the paths it expected', async () => {
  const site = copy((dir) => fs.rmSync(join(dir, 'private'), { recursive: true }));
  const { manifest, problems } = await read(site);
  expect(manifest).toBeNull();
  expect(problems).toEqual(
    ['sampling/exercises/estimate.yaml', 'sampling/tests/quiz.yaml'].map((path) =>
      expect.objectContaining({
        severity: 'error',
        path,
        overlay: true,
        message: 'no definition here',
      }),
    ),
  );
});

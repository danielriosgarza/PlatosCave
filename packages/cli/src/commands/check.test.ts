import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, test, vi } from 'vitest';
import { readCourseForSync } from '../folder/read';
import { main } from '../main';
import { LEVEL_0 } from './check';

delete process.env.DATABASE_URL;
const fixture = resolve(import.meta.dirname, '../../fixtures/course');
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-check-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
const course = 'courses/reef-ecology';
let sites = 0;
/** `parallax check` with `args` in a copy of the fixture site changed by `change`. */
async function check(change: (site: string) => void, args: string[] = []) {
  const site = join(temp, `site-${sites++}`);
  fs.cpSync(fixture, site, { recursive: true });
  change(site);
  const lines: string[] = [];
  const print = (line: string) => lines.push(line);
  const log = vi.spyOn(console, 'log').mockImplementation(print);
  const error = vi.spyOn(console, 'error').mockImplementation(print);
  try {
    return { code: await main(['check', ...args], { cwd: site }), lines, site };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}
const edit = (site: string, file: string, change: (text: string) => string) =>
  fs.writeFileSync(join(site, file), change(fs.readFileSync(join(site, file), 'utf8')));
const noOverlay = (site: string) => fs.rmSync(join(site, 'private'), { recursive: true });
/** What `run` gives, and each folder it lists through node:fs, resolved. */
async function listing<T>(run: () => Promise<T>) {
  const [listed, real] = [[] as string[], fs.readdirSync as (...args: unknown[]) => unknown];
  const list = (path: unknown, ...rest: unknown[]) => {
    listed.push(resolve(String(path)));
    return real(path, ...rest);
  };
  Object.assign(fs, { readdirSync: list });
  syncBuiltinESMExports();
  try {
    return { ...(await run()), listed };
  } finally {
    Object.assign(fs, { readdirSync: real });
    syncBuiltinESMExports();
  }
}

test('without private/, check at level 1 names the paths in private/, and at level 0 passes with its note', async () => {
  const level1 = await check(noOverlay);
  expect(level1.code).toBe(1);
  const absent = ['exercises/estimate.yaml', 'tests/quiz.yaml'].map(
    (file) => `private/${course}/sampling/${file}: no definition here`,
  );
  expect(level1.lines).toEqual(expect.arrayContaining(absent));
  const level0 = await check((site) => {
    noOverlay(site);
    edit(site, 'parallax.config.ts', (text) => text.replace('level: 1', 'level: 0'));
  });
  expect(level0).toMatchObject({ code: 0, lines: expect.arrayContaining([LEVEL_0]) });
});

test('a key that a definition’s schema drops is a note with its line, and check exits 0', async () => {
  const exercise = `private/${course}/sampling/exercises/estimate.yaml`;
  const misspelt = (text: string) =>
    text.replace('    hints:', '    hnts: [Typed wrong]\n    toString: Inherited\n    hints:');
  const { code, lines } = await check((site) => edit(site, exercise, misspelt));
  expect(code).toBe(0);
  const note = 'no field of its schema, so it is not stored';
  expect(lines).toContain(`note: ${exercise}: steps[0].hnts: ${note} (line 12)`);
  // A name that every object inherits is dropped all the same.
  expect(lines).toContain(`note: ${exercise}: steps[0].toString: ${note} (line 13)`);
});

test('check takes no argument, and prints a format character in a name as its code point', async () => {
  expect((await check(() => {}, ['--every'])).code).toBe(2);
  const name = 'reading‮dm.md';
  const write = (site: string) =>
    fs.writeFileSync(join(site, course, `sampling/reading/${name}`), '# Read\n');
  const { code, lines } = await check(write);
  expect(code).toBe(1);
  const unlisted = `${course}/sampling/reading/reading\\u{202e}dm.md: no entry of topic.yaml lists it`;
  expect(lines).toContain(unlisted);
  // An escape sequence in a key and in a file value: printed as code points too.
  const planted = await check((site) => {
    edit(site, `${course}/course.yaml`, (text) => `${text}"\\e[2Jboom": 1\n`);
    const file = (text: string) => text.replace('reading/methods.md', '"reading/\\e[2Jm.md"');
    edit(site, `${course}/sampling/topic.yaml`, file);
  });
  expect(planted.lines.filter((line) => /\p{C}/u.test(line))).toEqual([]);
  const shown = planted.lines.join('\n');
  expect(shown).toContain(`${course}/course.yaml: \\u{1b}[2Jboom: unknown key`);
  expect(shown).toContain('resources[1].file: no file sampling/reading/\\u{1b}[2Jm.md');
});

test('a topic whose id is an alias is named at its own topic.yaml, and the course folder is listed only by the reader', async () => {
  // A topic that lists nothing, which publication's report names by its folder.
  const aliased = (site: string) => {
    const id = (text: string) => text.replace(/^id: (\S+)$/m, 'objective: &topic $1\nid: *topic');
    const empty = (text: string) => id(text).replace(/resources:[\s\S]*/, 'resources: []\n');
    edit(site, `${course}/tides/topic.yaml`, empty);
    fs.rmSync(join(site, course, 'tides/reading/tides.html'));
  };
  const { code, lines, site, listed } = await listing(() => check(aliased));
  expect(code).toBe(0);
  expect(lines).toContain(
    `warning: ${course}/tides/topic.yaml: “Tides and zones” has no resources`,
  );
  // After the reader has returned, check lists the course folder no second time.
  const dir = join(site, course);
  const reader = await listing(() =>
    readCourseForSync(dir, { overlay: join(site, 'private', course) }),
  );
  const own = (paths: string[]) => paths.filter((path) => path === dir);
  expect(own(reader.listed).length).toBeGreaterThan(0);
  expect(own(listed)).toEqual(own(reader.listed));
});

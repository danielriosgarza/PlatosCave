import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { readCourseForSite, readCourseForSync, readCourseHeader } from './read';

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
const edit = (file: string, change: (text: string) => string) =>
  fs.writeFileSync(file, change(fs.readFileSync(file, 'utf8')));
type Call = (path: unknown, ...rest: unknown[]) => unknown;
const writable = fs as unknown as Record<string, Call>;
/** What `run` gives, and each path it asks node:fs to read or list, as `<function> <path>`. */
async function watch<T>(run: () => Promise<T>) {
  const [seen, names] = [[] as string[], ['readFileSync', 'openSync', 'readdirSync']];
  const real = names.map((name) => writable[name] as Call);
  names.forEach((name, i) => {
    writable[name] = (at, ...rest) => seen.push(`${name} ${String(at)}`) && real[i]?.(at, ...rest);
  });
  syncBuiltinESMExports();
  try {
    return { ...(await run()), seen: seen.map((line) => line.replaceAll('\\', '/')) };
  } finally {
    for (const [i, name] of names.entries()) writable[name] = real[i] as Call;
    syncBuiltinESMExports();
  }
}

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
  const real = { ...writable };
  const deny = (name: string, ...path: string[]) => {
    writable[name] = (at, ...rest) => {
      if (resolve(String(at)) === join(...path)) throw Object.assign(Error(), { code: 'EACCES' });
      return real[name]?.(at, ...rest);
    };
    syncBuiltinESMExports();
  };
  const denied = async (change: (site: string) => void) => {
    try {
      return await read(copy(change));
    } finally {
      for (const name of ['lstatSync', 'readFileSync']) writable[name] = real[name] as Call;
      syncBuiltinESMExports();
    }
  };
  const overlayAt = (site: string) => join(site, 'private', course);
  const overlayAsFile = (site: string) => {
    fs.rmSync(overlayAt(site), { recursive: true });
    fs.writeFileSync(overlayAt(site), '');
  };
  const changes: [path: string, change: (site: string) => void, overlay?: true][] = [
    ['sampling/reading/out', (site) => link(site, site, 'out')],
    ['sampling/reading/quiz', (site) => link(site, join(site, 'private', course), 'quiz')],
    ['sampling/topic.yaml', (site) => rename(site, reading, 'methods.md', 'Methods.md')],
    // The folder of a test, spelled in another case, is the folder of no test.
    ['sampling/tests/Quiz/q3/main.py', (site) => rename(site, tests, 'quiz', 'Quiz'), true],
    ['sampling/Tests', (site) => fs.mkdirSync(join(site, course, 'sampling/Tests'))],
    ['sampling/Exercises', (site) => fs.mkdirSync(join(site, course, 'sampling/Exercises'))],
    ['', (site) => deny('lstatSync', site, course)],
    ['', (site) => deny('lstatSync', site, 'private', course), true],
    ['sampling/tests/quiz.yaml', (site) => deny('readFileSync', site, tests, 'quiz.yaml'), true],
    ['', overlayAsFile, true],
  ];
  for (const [path, change, overlay] of changes) {
    const { manifest, problems } = await denied(change);
    expect(manifest).toBeNull();
    const named = { severity: 'error', path, ...(overlay && { overlay }) };
    expect(problems).toContainEqual(expect.objectContaining(named));
  }
  // The course folder itself: a link to it, also written with a separator at its end, and a
  // spelling the listing does not have.
  const linked = copy((site) => link(site, join(site, course), '../../../reef'));
  const named = [expect.objectContaining({ severity: 'error', path: '' })];
  expect((await read(linked, 'courses/reef')).problems).toEqual(named);
  expect((await read(linked, 'courses/reef/')).problems).toEqual(named);
  expect((await read(fixture, 'courses/Reef-Ecology')).problems).toEqual(named);
  // The course's folder in the overlay as a link, written so too: refused, and not read through.
  const moved = copy((site) => {
    fs.renameSync(overlayAt(site), `${overlayAt(site)}-moved`);
    fs.symlinkSync(`${overlayAt(site)}-moved`, overlayAt(site), 'junction');
  });
  const through = await readCourseForSync(join(moved, course), { overlay: `${overlayAt(moved)}/` });
  const refused = { code: 'overlay', path: '', overlay: true };
  expect(through.problems).toContainEqual(expect.objectContaining(refused));
  expect(through.problems.filter((p) => p.message === 'no definition here')).toHaveLength(2);
});

test('a file entry that leaves its tab folder is refused at topic.yaml and opens nothing', async () => {
  const files = ['a\\..\\..\\x.md', 'x:y.md', '..\\..\\private\\x.md', 'reading/../slides/x.md'];
  // The last is a reading by the layout table, and is looked up among the names the listing gave.
  for (const file of [...files, 'reading/..\\..\\x.md']) {
    const topic = (site: string) => join(site, course, 'sampling/topic.yaml');
    const site = copy((dir) =>
      edit(topic(dir), (text) => text.replace('slides/transects.md', file)),
    );
    const { manifest, problems, seen } = await watch(() => read(site));
    expect(manifest).toBeNull();
    const named = { severity: 'error', path: 'sampling/topic.yaml', field: 'resources[0].file' };
    expect(problems).toContainEqual(expect.objectContaining(named));
    expect(seen.filter((line) => /[xy]\.md$/.test(line))).toEqual([]);
  }
});

test('the site entry opens no file under exercises/, tests/ or private/, and lists none there', async () => {
  const leaking = resolve(fixture, '../course-leaking');
  for (const site of [fixture, leaking]) {
    const { seen } = await watch(() => readCourseForSite(join(site, course)));
    expect(seen.filter((line) => line.includes('/private/'))).toEqual([]);
    const opened = seen.filter((line) => !line.startsWith('readdirSync'));
    expect(opened.filter((line) => /\/(exercises|tests)\//.test(line))).toEqual([]);
    expect(opened.length).toBeGreaterThan(0);
  }
});

test('a tree declared private that holds its definitions gives the manifests of the public form', async () => {
  const site = copy((dir) => {
    fs.cpSync(join(dir, 'private', course), join(dir, course), { recursive: true });
    fs.rmSync(join(dir, 'private'), { recursive: true });
    edit(join(dir, course, 'course.yaml'), (text) => text.replace('public: true', 'public: false'));
  });
  const [open, closed] = [await read(fixture), await read(site)];
  expect(closed.problems).toEqual([]);
  const unmarked = JSON.stringify(open.manifest).replaceAll('"overlay":true', '"overlay":false');
  expect(closed.manifest).toEqual(JSON.parse(unmarked.replace('"public":true', '"public":false')));
  const [served, kept] = [fixture, site].map((dir) => readCourseForSite(join(dir, course)));
  expect((await kept)?.manifest).toEqual((await served)?.manifest);
});

test('without private/, a course declared public stops the reader with the paths it expected', async () => {
  const site = copy((dir) => fs.rmSync(join(dir, 'private'), { recursive: true }));
  const { manifest, problems } = await read(site);
  expect(manifest).toBeNull();
  const absent = { severity: 'error', overlay: true, message: 'no definition here' };
  const paths = ['sampling/exercises/estimate.yaml', 'sampling/tests/quiz.yaml'];
  expect(problems).toEqual(paths.map((path) => expect.objectContaining({ ...absent, path })));
});

test('without private/, the site entry gives the manifest of a tree declared public', async () => {
  const site = copy((dir) => fs.rmSync(join(dir, 'private'), { recursive: true }));
  const { manifest, problems } = await readCourseForSite(join(site, course));
  expect(problems).toEqual([]);
  const types = manifest?.topics.flatMap((topic) => topic.resources.map((r) => r.type));
  const sampling = ['slides_web', 'reading_native', 'notebook', 'exercise', 'slides_pdf', 'shiny'];
  expect(types).toEqual(['reading_native', ...sampling, 'test']);
});

test('readCourseHeader gives the title of course.yaml, and nothing where it is absent or not valid', () => {
  expect(readCourseHeader(join(fixture, course))).toEqual({ title: 'Reef ecology' });
  const dir = join(temp, 'header');
  fs.mkdirSync(dir);
  expect(readCourseHeader(dir)).toBeUndefined();
  const invalid = [
    'title: "  "\npublic: true\n',
    'title: [Reef]\n',
    'public: true\n',
    'title: a\ntitle: b\n',
  ];
  for (const yaml of invalid) {
    fs.writeFileSync(join(dir, 'course.yaml'), yaml);
    expect(readCourseHeader(dir)).toBeUndefined();
  }
  fs.writeFileSync(join(dir, 'course.yaml'), 'title: "  Coral reefs "\n');
  expect(readCourseHeader(dir)).toEqual({ title: 'Coral reefs' });
});

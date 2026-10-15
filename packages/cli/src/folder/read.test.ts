import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { type Problem, readCourseForSite, readCourseForSync, readCourseHeader } from './read';

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
/** The fixture's tree declared private, holding the definitions its overlay held. */
const declaredPrivate = (dir: string) => {
  fs.cpSync(join(dir, 'private', course), join(dir, course), { recursive: true });
  fs.rmSync(join(dir, 'private'), { recursive: true });
  edit(join(dir, course, 'course.yaml'), (text) => text.replace('public: true', 'public: false'));
};
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
// A function of node:fs that throws `fail(path)` for one path, as a denied permission does.
const untouched = { ...writable };
const failing =
  (fail: (at: unknown) => unknown) =>
  (name: string, ...path: string[]) => {
    writable[name] = (at, ...rest) => {
      if (resolve(String(at)) === join(...path)) throw fail(at);
      return untouched[name]?.(at, ...rest);
    };
    syncBuiltinESMExports();
  };
const deny = failing((at) => Object.assign(Error(), { code: 'EACCES', path: at }));
type Entry = (site: string) => Promise<{ manifest: unknown; problems: Problem[] }>;
const forSite: Entry = (site) => readCourseForSite(join(site, course));
/** What `entry` reads of a copy of the fixture changed by `change`; node:fs is restored after. */
async function denied(change: (site: string) => void, entry: Entry = read) {
  try {
    return await entry(copy(change));
  } finally {
    for (const name of ['lstatSync', 'readFileSync', 'readdirSync']) {
      writable[name] = untouched[name] as Call;
    }
    syncBuiltinESMExports();
  }
}
const overlayAt = (site: string) => join(site, 'private', course);
const overlayAsFile = (site: string) => {
  fs.rmSync(overlayAt(site), { recursive: true });
  fs.writeFileSync(overlayAt(site), '');
};
/** Each problem as `[overlay: ]<code> <path>`, so that a mark is seen where it should be absent. */
const shown = (problems: Problem[]) =>
  problems.map((p) => `${p.overlay ? 'overlay: ' : ''}${p.code} ${p.path}`);

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
  // A listing that fails is named once, at its folder, and nothing further is said of it.
  const lists: [path: string, root: string, overlay?: true][] = [
    ['sampling', course],
    ['sampling/notebooks', course],
    ['sampling/tests', `private/${course}`, true],
  ];
  for (const [path, root, overlay] of lists) {
    const { problems } = await denied((site) => deny('readdirSync', site, root, path));
    const named = { code: 'read', path, ...(overlay && { overlay }) };
    expect(problems).toEqual([expect.objectContaining(named)]);
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
  const site = copy(declaredPrivate);
  const [open, closed] = [await read(fixture), await read(site)];
  expect(closed.problems).toEqual([]);
  const unmarked = JSON.stringify(open.manifest).replaceAll('"overlay":true', '"overlay":false');
  expect(closed.manifest).toEqual(JSON.parse(unmarked.replace('"public":true', '"public":false')));
  const [served, kept] = [fixture, site].map((dir) => readCourseForSite(join(dir, course)));
  expect((await kept)?.manifest).toEqual((await served)?.manifest);
});

test('one unknown key in a topic.yaml is one problem, at that file, for the operator and for the site', async () => {
  const typo = (dir: string) =>
    edit(join(dir, course, 'sampling/topic.yaml'), (text) => `${text}colour: blue\n`);
  // In the tree declared public its definitions lie in the overlay; in the other, in the tree.
  const closed = (dir: string) => {
    declaredPrivate(dir);
    typo(dir);
  };
  const trees = [copy(typo), copy(closed)];
  const named = { severity: 'error', path: 'sampling/topic.yaml', field: 'colour' };
  for (const site of trees) {
    for (const { problems } of [await read(site), await readCourseForSite(join(site, course))]) {
      expect(problems).toEqual([expect.objectContaining(named)]);
    }
  }
});

test('each entry gives the folder of each topic by its folder id, and none for a refused tree', async () => {
  const folders = new Map([
    ['0b2f4a6c-8d1e-4f3a-b5c7-9e0a1b2c3d4e', 'tides'],
    ['5f0c1d8e-3b7a-4c2e-9a41-7d2f6b0e1c33', 'sampling'],
  ]);
  expect((await read(fixture)).folders).toEqual(folders);
  expect((await readCourseForSite(join(fixture, course))).folders).toEqual(folders);
  const refused = copy((dir) => fs.rmSync(join(dir, 'private'), { recursive: true }));
  expect((await read(refused)).folders).toEqual(new Map());
});

test('an overlay whose lstat is denied, or that is a file, is one problem, also beside a course folder that cannot be listed', async () => {
  const lstat = (site: string) => deny('lstatSync', overlayAt(site));
  expect(shown((await denied(lstat)).problems)).toEqual(['overlay: read ']);
  expect(shown((await denied(overlayAsFile)).problems)).toEqual(['overlay: overlay ']);
  // The course folder's listing is its one problem, and the overlay's own problems are named too.
  const unlisted = (site: string) => deny('readdirSync', site, course);
  const both = (site: string) => {
    overlayAsFile(site);
    unlisted(site);
  };
  expect(shown((await denied(both)).problems)).toEqual(['read ', 'overlay: overlay ']);
  expect(shown((await denied(unlisted, forSite)).problems)).toEqual(['read ']);
});

test('a value thrown that is not an Error is one read problem at the course folder, and the reader does not reject', async () => {
  // Thrown by the course folder's listing; the last one throws again for its `code`, past `attempt`.
  const values = [
    undefined,
    null,
    {
      get code() {
        throw undefined;
      },
    },
  ];
  for (const value of values) {
    const thrown = failing(() => value);
    const { problems } = await denied((site) => thrown('readdirSync', site, course));
    const message = `cannot be read (${value === null ? null : undefined})`;
    expect(problems).toEqual([{ severity: 'error', code: 'read', path: '', message }]);
  }
});

test('a listing denied to the site entry is one read problem, at its folder', async () => {
  // A tab folder that the reader lists, and tests/ of the tree declared public, which only the
  // listing of the answer folders reads.
  const folders: [string, (site: string) => void][] = [
    ['sampling/notebooks', () => {}],
    ['sampling/tests', (site) => fs.mkdirSync(join(site, course, 'sampling/tests'))],
  ];
  for (const [folder, make] of folders) {
    const change = (site: string) => {
      make(site);
      deny('readdirSync', site, course, folder);
    };
    expect(shown((await denied(change, forSite)).problems)).toEqual([`read ${folder}`]);
  }
});

test('a listing of answer folders that fails without a path, or with one outside both roots, is one problem at the course folder, marked as the reading marks', async () => {
  const tests = 'sampling/tests';
  for (const error of [{ code: 'EACCES' }, { code: 'EACCES', path: tmpdir() }]) {
    const thrown = failing(() => error);
    // The overlay's tests/ for the operator; tests/ of the tree declared public for the site.
    const overlay = (site: string) => thrown('readdirSync', overlayAt(site), tests);
    expect(shown((await denied(overlay)).problems)).toEqual(['overlay: read ']);
    const tree = (site: string) => {
      fs.mkdirSync(join(site, course, tests));
      thrown('readdirSync', site, course, tests);
    };
    expect(shown((await denied(tree, forSite)).problems)).toEqual(['read ']);
  }
});

test('of a topic whose topic.yaml is refused, only what its entries decide is left unsaid', async () => {
  const site = copy((dir) => {
    edit(join(dir, course, 'sampling/topic.yaml'), (text) => `${text}colour: blue\n`);
    fs.writeFileSync(join(overlayAt(dir), 'sampling/exercises/notes.txt'), 'Left here.\n');
  });
  // Its definitions are not called unlisted, nor its test's files misplaced; a stray file is named.
  const stray = 'overlay: layout sampling/exercises/notes.txt';
  expect(shown((await read(site)).problems)).toEqual(['schema sampling/topic.yaml', stray]);
});

test('a data file larger than one part is read in parts, with the sha256 and size of a whole read', async () => {
  const data = 'sampling/notebooks/counts/data/large.csv';
  // 2.5 MiB: more than two of the reader's parts.
  const bytes = Buffer.alloc(5 * 2 ** 19, 'depth,count\n');
  const site = copy((dir) => fs.writeFileSync(join(dir, course, data), bytes));
  // The bytes of each read through node:fs: a whole read of the file would give them all at once.
  const reads: number[] = [];
  writable.readSync = (...args) => {
    const length = untouched.readSync?.(...args);
    reads.push(Number(length));
    return length;
  };
  syncBuiltinESMExports();
  try {
    const { manifest } = await read(site);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const entry = { path: data, sha256, size: bytes.length, format: 'data' };
    expect(manifest?.files.find((file) => file.path === data)).toEqual(entry);
    expect(reads.reduce((sum, length) => sum + length, 0)).toBeGreaterThan(bytes.length);
    expect(Math.max(...reads)).toBeLessThan(bytes.length);
  } finally {
    writable.readSync = untouched.readSync as Call;
    syncBuiltinESMExports();
  }
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

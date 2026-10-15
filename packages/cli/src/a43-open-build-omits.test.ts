import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { main } from './main';
import { buildUnderGuard, filesOf, printing, STAND_IN } from './open/testing';

delete process.env.DATABASE_URL;
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-a43-open-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const [reef, pools] = ['courses/reef-ecology/sampling', 'courses/tide-pools'];
const SAMPLING = '5f0c1d8e-3b7a-4c2e-9a41-7d2f6b0e1c33';
let copies = 0;
/** A copy of the instructor fixture: a course declared public with its overlay, one declared not. */
function copy(): string {
  const root = join(temp, `site-${copies++}`);
  fs.cpSync(resolve(import.meta.dirname, '../fixtures/open-site/instructor'), root, {
    recursive: true,
  });
  return root;
}
const edit = (root: string, file: string, change: (text: string) => string) =>
  fs.writeFileSync(join(root, file), change(fs.readFileSync(join(root, file), 'utf8')));

// The sentinels by file: in the overlay of the public course, its hidden reading, and the tree of
// the course declared `public: false`.
const [exercise, quiz] = [
  'prompt answer feedback hint solution',
  'question answer rubric public-check hidden-check',
];
const planted = {
  [`private/${reef}/exercises/estimate.yaml`]: exercise,
  [`private/${reef}/tests/quiz.yaml`]: quiz,
  [`private/${reef}/tests/quiz/q3/main.py`]: 'code-file',
  [`private/${reef}/tests/quiz/q3/tests/check.py`]: 'hidden-file',
  [`${reef}/topic.yaml`]: 'hidden-title',
  [`${reef}/reading/hidden.pdf`]: 'hidden-pdf',
  [`${pools}/pools/exercises/identify.yaml`]: exercise,
  [`${pools}/pools/tests/check.yaml`]: quiz,
  [`${pools}/pools/tests/check/q3/main.py`]: 'code-file',
  [`${pools}/pools/tests/check/q3/tests/check.py`]: 'hidden-file',
  [`${pools}/practice/exercises/sort.yaml`]: exercise,
  [`${pools}/practice/tests/final.yaml`]: 'question final-answer',
};
const sentinels = (kinds: string) => kinds.split(' ').map((kind) => `sentinel-${kind}`);
// A read in two guarded places by the stand-in, once every course is built: the guard is on.
const plants = [`private/${reef}/exercises/estimate.yaml`, `${pools}/pools/tests/check.yaml`];
const planting = STAND_IN.replace(
  '{',
  `{ for (const file of ${JSON.stringify(plants)}) try { fs.readFileSync(join(root, file)); } catch {}`,
);

let first: ReturnType<typeof buildUnderGuard> & { root: string };
beforeAll(() => {
  const root = copy();
  // A link in a notebook's data folder to the folder of the hidden reading, as in course.test.ts.
  fs.symlinkSync(join(root, reef, 'reading'), join(root, reef, 'notebooks/counts/r'), 'junction');
  first = { ...buildUnderGuard(root, planting), root };
}, 300_000);

test('A43 no file of a level 0 build holds a hidden check, a solution or a correct answer', () => {
  const { root, files, status } = first;
  // Each sentinel is first found where it was planted, so that a search that finds none counts.
  const absent = Object.entries(planted).flatMap(([file, kinds]) => {
    const text = fs.readFileSync(join(root, file), 'latin1');
    return sentinels(kinds).filter((word) => !text.includes(word));
  });
  const words = [...new Set(Object.values(planted).flatMap(sentinels))];
  // Every file of .parallax/open/ and dist/, of site/ and content/, read as bytes.
  const held = [...files].flatMap(([path, bytes]) =>
    words.filter((word) => bytes.includes(word)).map((word) => `${path}: ${word}`),
  );
  expect([status, absent, files.size > 60, held]).toEqual([0, [], true, []]);
  // Each exercise and test is listed in its topic.json by its title.
  const topics = [...files].filter(([path]) => /^dist\/site\/.*\/topic\.json$/.test(path));
  const titles = topics.map(([path, bytes]) => {
    const { exercises, tests } = JSON.parse(String(bytes));
    return [path.split('/').at(-2), [...exercises, ...tests].map((entry) => entry.title)];
  });
  expect(Object.fromEntries(titles)).toEqual({
    [SAMPLING]: ['Estimate a density', 'Sampling quiz'],
    '0b2f4a6c-8d1e-4f3a-b5c7-9e0a1b2c3d4e': [],
    '6d1e2f3a-4b5c-4d6e-8f7a-9b0c1d2e3f4a': ["Identify a pool's dwellers", 'Pools check'],
    '1c6d7e8f-9a0b-4c1d-9e2f-4a5b6c7d8e9f': ['Sort the dwellers', 'Final check'],
    '4f9a0b1c-2d3e-4f4a-8b5c-7d8e9f0a1b2c': [],
  });
});

test('A43 a level 0 build opens no file under exercises/, tests/ or private/', () => {
  const { root, files, refused } = first;
  // Both courses were built, and the guard recorded the stand-in's two reads and no other.
  const built = ['reef-ecology', 'tide-pools'].map(
    (name) => `dist/site/courses/${name}/course.json`,
  );
  expect(built.filter((path) => !files.has(path))).toEqual([]);
  expect(refused.map(({ path }) => path)).toEqual(plants.map((file) => resolve(root, file)));
});

test('A43 parallax build at level 0 refuses a public tree that holds a definition, as parallax check does', async () => {
  const root = copy();
  fs.mkdirSync(join(root, 'dist'));
  fs.writeFileSync(join(root, 'dist/index.html'), 'an earlier build');
  // The overlay's definitions moved into the tree of the course declared public.
  fs.cpSync(join(root, 'private', reef), join(root, reef), { recursive: true });
  fs.rmSync(join(root, 'private'), { recursive: true });
  const check = await printing(() => main(['check'], { cwd: root }));
  const run = buildUnderGuard(root, 'command');
  const errors = (lines: string[]) =>
    lines.filter((line) => line && !/^(warning|note): |^parallax /.test(line));
  const held = 'a tree declared public holds no exercise or test: it belongs in the overlay';
  const leaked = [
    'exercises/estimate.yaml',
    'tests/quiz.yaml',
    'tests/quiz/q3/main.py',
    'tests/quiz/q3/tests/check.py',
  ];
  expect([check.result, errors(check.lines)]).toEqual([
    1,
    leaked.map((file) => `${reef}/${file}: ${held}`),
  ]);
  expect([run.status, errors(run.stdout.split('\n')), run.refused]).toEqual([
    1,
    errors(check.lines),
    [],
  ]);
  const dist = [...run.files].filter(([path]) => path.startsWith('dist/'));
  expect(dist).toEqual([['dist/index.html', Buffer.from('an earlier build')]]);
}, 300_000);

test('a second build into a used site folder leaves nothing of a resource that was hidden or removed since', () => {
  const { root } = first;
  const resource = (file: string, id: string, title: string) => {
    const digest = sha(fs.readFileSync(join(root, reef, file)));
    return { file, id, title, digest };
  };
  const paper = resource(
    'reading/paper.pdf',
    '0c9d8e7f-6a5b-4c3d-9e2f-1a0b9c8d7e6f',
    'Counting fish along a transect',
  );
  const zones = resource('slides/zones.pdf', '6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d', 'Reef zones');
  /** The places that hold a trace of a resource: its data file, its file, its title or its id. */
  const traces = (output: Map<string, Buffer>, { id, title, digest } = paper) => {
    const traced = [...output].filter(
      ([path, bytes]) =>
        path.endsWith(`/${id}.json`) ||
        sha(bytes) === digest ||
        bytes.includes(title) ||
        bytes.includes(id),
    );
    return [...new Set(traced.map(([path]) => path.split('/')[0]))].sort();
  };
  /** The output of the build before: both trees in the work folder, copied back if placed away. */
  const before = () => {
    for (const tree of ['site', 'content']) {
      const work = join(root, '.parallax/open', tree);
      if (!fs.existsSync(work)) fs.cpSync(join(root, 'dist', tree), work, { recursive: true });
    }
    return new Map([
      ...filesOf(join(root, '.parallax/open'), '.parallax/open/'),
      ...filesOf(join(root, 'dist'), 'dist/'),
    ]);
  };
  const both = ['.parallax', 'dist'];
  expect([traces(before()), traces(before(), zones)]).toEqual([both, both]);
  const yaml = `${reef}/topic.yaml`;
  edit(root, yaml, (text) =>
    text.replace(`file: ${paper.file}\n`, `file: ${paper.file}\n    visibility: hidden\n`),
  );
  const second = buildUnderGuard(root);
  expect([second.status, traces(second.files), traces(before(), zones)]).toEqual([0, [], both]);
  edit(root, yaml, (text) => text.replace(/ {2}- id: 6a5b4c3d[\s\S]*?(?= {2}- id: )/, ''));
  fs.rmSync(join(root, reef, zones.file));
  const third = buildUnderGuard(root);
  expect([third.status, traces(third.files), traces(third.files, zones)]).toEqual([0, [], []]);
}, 300_000);

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { StoredNotebook } from '@parallax/contracts';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { vendor } from '../../scripts/vendor';
import { readCourseForSite } from '../folder/read';
import type { Problem } from '../folder/yaml';
import { loadSource } from '../paths';
import { buildCourse, conversionIo } from './course';
import { notebookDownload } from './download';
import { createOutput } from './output';
import { moduleUrl, underGuard } from './testing';

delete process.env.DATABASE_URL;
const fixtures = resolve(import.meta.dirname, '../../fixtures/open-site');
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-open-course-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
type Contracts = typeof import('@parallax/contracts');
const contracts = await loadSource<Contracts>('contracts', 'src/index.ts');
const { courseRef, objectExtension, openNotebookFile, openPaths, viewNotebook } = contracts;
type Server = {
  convertRevision(source: object, io: object): Promise<{ derived: Record<string, unknown> }>;
  resolveReadingImages(html: string, urlFor: (key: string) => string | null): string;
};
const { convertRevision } = await loadSource<Server>('server', 'src/content/convert.ts');
const { resolveReadingImages } = await loadSource<Server>('server', 'src/content/reading.ts');

const [CONTENT, SHINY] = ['https://content.reef.example.org', ['https://shiny.example.org']];
/** The fixture's course "Reef ecology", in a folder whose name needs percent-encoding. */
const NAME = 'Reef ecology #1 50%';
const SAMPLING = '5f0c1d8e-3b7a-4c2e-9a41-7d2f6b0e1c33';
const sampling = join(fixtures, 'instructor/courses/reef-ecology/sampling');
const yaml = fs.readFileSync(join(sampling, 'topic.yaml'), 'utf8');
/** The folder id of an entry of the topic "Sampling a reef", by its file. */
const idOf = (file: string) => RegExp(`id: (\\S+)\\s+file: ${file}\\s`).exec(yaml)?.[1] ?? '';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const errors = (problems: Problem[]) => problems.filter((p) => p.severity === 'error');
const lines = (problems: Problem[]) => problems.map((p) => `${p.severity} ${p.code} ${p.path}`);
const ids = (list: { resourceId: string }[]) => list.map((r) => r.resourceId);
/** The path under the work folder of what an address names: an object, or a data file. */
const at = (address: string) =>
  address.replace(CONTENT, 'content').replace(/^\/.*/, (path) => `site${decodeURIComponent(path)}`);
/** Every file below a folder, by its path with `/`. */
const filesOf = (root: string) =>
  new Map(
    fs
      .readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((path) => fs.statSync(join(root, path)).isFile())
      .map((path) => [path.split(sep).join('/'), fs.readFileSync(join(root, path))]),
  );
let copies = 0;
/** A copy of a fixture site in the temporary folder. */
function copy(site: string): string {
  const root = join(temp, `${site}-${copies++}`);
  fs.cpSync(join(fixtures, site), root, { recursive: true });
  return root;
}
/** Writes a file of the topic "Sampling a reef" in a copy of the instructor site. */
const into = (root: string, file: string, bytes: string | Buffer) =>
  fs.writeFileSync(join(root, 'courses/reef-ecology/sampling', file), bytes);
const said = (problems: Problem[]) => problems.map((p) => `${p.code} ${p.path}: ${p.message}`);
/** Builds one course of a site into its work folder: the problems, and every file written. */
async function build(root: string, course = 'courses/reef-ecology', ref = 'reef-ecology') {
  const work = join(root, '.parallax/open');
  const out = await createOutput({ workDir: work, contentOrigin: CONTENT });
  const options = { dir: join(root, course), ref, instructors: ['Ana Lima'], shinyOrigins: SHINY };
  const { problems } = await buildCourse(options, out);
  return { out, problems, files: filesOf(work) };
}

let main: Awaited<ReturnType<typeof build>>;
beforeAll(async () => {
  const root = copy('instructor');
  fs.renameSync(join(root, 'courses/reef-ecology'), join(root, 'courses', NAME));
  main = await build(root, `courses/${NAME}`, courseRef('instructor', '.', NAME));
}, 300_000);
const json = (path: string) => JSON.parse(String(main.files.get(path)));
const topicOf = () => json(at(openPaths.topicData(NAME, SAMPLING)));
const dataPath = (file: string) => at(openPaths.resourceData(NAME, SAMPLING, idOf(file)));
const resource = (file: string) => json(dataPath(file));
/** Conversion's derived output for a file of the topic "Sampling a reef". */
async function derive(type: string, file: string, content: object = { objectKey: 'k' }) {
  const read = async () => new Uint8Array(fs.readFileSync(join(sampling, file)));
  const io = { read, prefix: 'open' };
  return (await convertRevision({ type, content, objectKeys: ['k'] }, io)).derived;
}

test('buildCourse writes the material that conversion gives, every object on the content origin', async () => {
  const currents = 'sampling/notebooks/currents.shiny.yaml';
  expect(lines(main.problems)).toEqual([`warning unapproved_shiny_origin ${currents}`]);
  // The data file lies at the address of its course, each folder name percent-encoded there.
  expect(openPaths.courseData(NAME)).toBe('/courses/Reef%20ecology%20%231%2050%25/course.json');
  const { topics } = json(at(openPaths.courseData(NAME)));
  const tides = [1, '0b2f4a6c-8d1e-4f3a-b5c7-9e0a1b2c3d4e', 'Tides and zones'];
  const order = topics.map((t: Record<string, unknown>) => [t.number, t.topicId, t.title]);
  expect(order).toEqual([tides, [2, SAMPLING, 'Sampling a reef']]);
  const topic = topicOf();
  const notebooks = ['counts.ipynb', 'tide.shiny.yaml', 'currents.shiny.yaml'];
  expect([ids(topic.slides), ids(topic.notebooks)]).toEqual([
    ['slides/transects.md', 'slides/zones.pdf'].map(idOf),
    notebooks.map((file) => idOf(`notebooks/${file}`)),
  ]);
  expect(topic.reading).toEqual([
    { resourceId: idOf('reading/methods.md'), title: 'Survey methods', kind: 'native' },
    { resourceId: idOf('reading/paper.pdf'), title: 'Counting fish along a transect', kind: 'pdf' },
  ]);

  const markdown = fs.readFileSync(join(sampling, 'slides/transects.md'), 'utf8');
  const { slides } = await derive('slides_web', '', { markdown });
  const web = { type: 'slides', title: 'Transect surveys', pdf: null, web: { slides } };
  expect(resource('slides/transects.md')).toEqual(web);
  for (const path of ['slides/zones.pdf', 'reading/paper.pdf']) {
    const bytes = fs.readFileSync(join(sampling, path));
    const { pageCount } = await derive(`${path.split('/')[0]}_pdf`, path);
    expect(resource(path).pdf).toEqual({ url: `${CONTENT}/o/${sha(bytes)}.pdf`, pageCount });
    expect(main.files.get(`content/o/${sha(bytes)}.pdf`)).toEqual(bytes);
  }
  expect([...main.files.keys()].filter((path) => path.endsWith('.pdf'))).toHaveLength(2);
  // A reading from a folder has no image: its HTML is conversion's, as it is.
  const native = { sourceKey: 'k', format: 'markdown' };
  const { html } = await derive('reading_native', 'reading/methods.md', native);
  const methods = { type: 'reading', title: 'Survey methods', kind: 'native', html, pdf: null };
  expect(resource('reading/methods.md')).toEqual(methods);

  const converted = await derive('notebook', 'notebooks/counts.ipynb', { sourceKey: 'k' });
  const types = converted.objects as Record<string, string>;
  const urlFor = (key: string) =>
    `${CONTENT}/o/${key.split('/').pop()}.${objectExtension(types[key] ?? '')}`;
  const view = viewNotebook(converted.notebook as StoredNotebook, urlFor, resolveReadingImages);
  const counts = resource('notebooks/counts.ipynb');
  expect(counts.notebook).toEqual(view);
  const kinds = ['image/png', 'image/png', 'image/svg+xml', 'text/html; charset=utf-8'];
  expect(Object.values(types).sort()).toEqual(kinds);
  // Two images, an SVG, an HTML output and the file for download: each a file under content/.
  const named = [...JSON.stringify(counts).matchAll(/https:[^"\\]+/g)].map(([address]) => address);
  expect(named.filter((address) => main.files.has(at(address)))).toEqual(named);
  const file = JSON.parse(String(main.files.get(at(counts.file))));
  expect([named.length, file]).toEqual([5, openNotebookFile.parse(notebookDownload(view))]);
  const code = file.cells.filter((cell: { cell_type: string }) => cell.cell_type === 'code');
  expect(code.map((cell: { outputs: [] }) => cell.outputs)).toEqual([[], [], []]);
  // Its one image, in the Markdown cell, is the one the data file names: a file under content/.
  const sources = [...JSON.stringify(file).matchAll(/src=\\"([^"\\]+)/g)].map(([, src]) => src);
  expect(sources).toEqual([named[1]]);
  const stored = counts.notebook.cells.find((cell: { id: string }) => cell.id === 'stored');
  expect([stored.source, stored.outputs[0].text]).toEqual(["print('RUN')", 'STORED\n']);
  const own = sha(fs.readFileSync(join(sampling, 'notebooks/counts.ipynb')));
  expect([...main.files.values()].map(sha)).not.toContain(own);

  const app = { type: 'shiny', title: 'Tide explorer', url: 'https://shiny.example.org/tide/' };
  expect(resource('notebooks/tide.shiny.yaml')).toEqual({ ...app, origin: SHINY[0] });
  const elsewhere = { title: 'Current explorer', url: 'https://apps.example.net/currents/' };
  expect(resource('notebooks/currents.shiny.yaml')).toEqual({ ...app, ...elsewhere, origin: null });
  // The converter's own output, a formula's MathML and code that holds `<`, passes the audit.
  expect(methods.html).toMatch(/<math[\s\S]*<code[^>]*>[\s\S]*&#x3C;/);
  main.out.shell('index.html', new TextEncoder().encode('<!doctype html><title>Reef</title>'));
  expect(() => main.out.finish()).not.toThrow();
}, 120_000);

test('a resource marked hidden in topic.yaml has no entry, no data file and no object', () => {
  const topic = topicOf();
  const listed = Object.values<{ resourceId: string }[]>(topic).flatMap(ids);
  const written = (file: string) => main.files.has(dataPath(file));
  const object = (file: string) =>
    main.files.has(`content/o/${sha(fs.readFileSync(join(sampling, file)))}.pdf`);
  const all = (file: string) => [listed.includes(idOf(file)), written(file), object(file)];
  expect(all('reading/hidden.pdf')).toEqual([false, false, false]);
  expect(all('reading/paper.pdf')).toEqual([true, true, true]);
  const [estimate, quiz] = ['exercises/estimate.yaml', 'tests/quiz.yaml'];
  expect(topic.exercises).toEqual([{ resourceId: idOf(estimate), title: 'Estimate a density' }]);
  expect(topic.tests).toEqual([{ resourceId: idOf(quiz), title: 'Sampling quiz' }]);
  expect([written(estimate), written(quiz)]).toEqual([false, false]);
  // In a comment the reading pipeline drops, in a data file, and the instructor's address.
  for (const [file, marker] of [
    ['reading/methods.md', 'only-in-a-comment'],
    ['notebooks/counts/data/quadrats.csv', 'only-in-a-data-file'],
    ['../../../instructor.yaml', 'ana.lima@example.org'],
  ] as const) {
    expect(fs.readFileSync(join(sampling, file), 'utf8')).toContain(marker);
    const holding = [...main.files].filter(([, bytes]) => bytes.includes(marker));
    expect(holding.map(([path]) => path)).toEqual([]);
  }
});

test('buildCourse opens no file under exercises/, tests/ or private/', () => {
  const [ana, bao] = ['instructors/ana/courses/reef-ecology', 'instructors/bao/courses/tide-pools'];
  // A planted read is a call on its path `p`: through a file: URL, a blob, a stream, a read, a copy
  // and a file handle. The instructor layout takes the first three.
  const calls = ['fs.promises.readFile(pathToFileURL(p))', 'fs.openAsBlob(p)'];
  calls.push('fs.createReadStream(p)', 'fs.readFileSync(p)', "fs.copyFileSync(p, p + '.copy')");
  calls.push('fs.promises.open(p)');
  const sites = [
    ['instructor', 'courses/reef-ecology', 'courses/tide-pools'],
    ['school', ana, bao],
  ];
  for (const [mode = '', open = '', closed = ''] of sites) {
    const root = copy(mode);
    const link = (target: string, path: string) =>
      fs.symlinkSync(join(root, target), join(root, path), 'junction');
    // A link in a notebook's data folder: in the course declared public to the folder of its
    // hidden reading; in a copy of the course declared private to its tests/.
    link(`${open}/sampling/reading`, `${open}/sampling/notebooks/counts/r`);
    fs.cpSync(join(root, closed), join(root, `${closed}-linked`), { recursive: true });
    link(`${closed}-linked/pools/tests`, `${closed}-linked/pools/notebooks/survey/x`);
    const courses = [open, closed, `${closed}-linked`];
    const builds = courses.map((course) => {
      const [, name = '', , folder = ''] = course.split('/');
      const ref = mode === 'school' ? courseRef(mode, name, folder) : name;
      return { dir: join(root, course), ref, instructors: ['Ana Lima'], shinyOrigins: SHINY };
    });
    // A read planted in each of the three places.
    const planted = [
      join(root, 'private', open, 'sampling/exercises/estimate.yaml'),
      join(root, closed, 'pools/exercises/identify.yaml'),
      join(root, closed, 'pools/tests/check/q3/main.py'),
    ];
    const plants = planted.map((path, i) => [calls[mode === 'school' ? i + 3 : i], path]);
    const run = underGuard(
      { site: root, courses: courses.map((course) => join(root, course)) },
      `const fs = await import('node:fs');
      const { pathToFileURL } = await import('node:url');
      const { createOutput } = await import(${JSON.stringify(moduleUrl('open/output.ts'))});
      const { buildCourse } = await import(${JSON.stringify(moduleUrl('open/course.ts'))});
      const [workDir, builds, plants] = ${JSON.stringify([join(root, '.parallax/open'), builds, plants])};
      const out = await createOutput({ workDir, contentOrigin: '${CONTENT}' });
      const errors = [];
      for (const build of builds) {
        const { problems } = await buildCourse(build, out);
        errors.push(problems.filter((p) => p.severity === 'error').map((p) => p.path));
      }
      const rejected = [];
      for (const [call, p] of plants) {
        rejected.push(await (async () => eval(call))().then(() => false, () => true));
      }
      console.log(JSON.stringify({ errors, rejected }));`,
    );
    expect(run.status, run.stderr).toBe(0);
    const { errors, rejected } = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '');
    // Both courses build, the public one with its link to the hidden reading, and the guard
    // recorded no read of theirs. Through the link to tests/ the reader reads the test's files:
    // the guard, which judges a path with its links resolved, refuses and records each read.
    const inTests = ['check.yaml', 'check/q3/main.py', 'check/q3/tests/check.py'];
    expect(errors).toEqual([[], [], inTests.map((file) => `pools/notebooks/survey/x/${file}`)]);
    expect(rejected).toEqual([true, true, true]);
    const tests = inTests.map((file) => join(root, `${closed}-linked/pools/tests`, file));
    const real = (paths: string[]) => paths.map((path) => fs.realpathSync.native(path)).sort();
    expect(real(run.refused.map((r) => r.real))).toEqual(real([...planted, ...tests]));
    const through = run.refused.filter((r) => r.path.includes(`${sep}x${sep}`));
    expect(through.map((r) => r.call)).toEqual(['readFileSync', 'readFileSync', 'readFileSync']);
    // No file written has the bytes of a file of private/, of tests/ or of the hidden reading.
    const kept = [join(root, 'private'), join(root, closed, 'pools/tests')].map(filesOf);
    const bytes = kept.flatMap((files) => [...files.values()]);
    bytes.push(fs.readFileSync(join(root, open, 'sampling/reading/hidden.pdf')));
    const emitted = new Set([...filesOf(join(root, '.parallax/open')).values()].map(sha));
    expect([emitted.size > 20, bytes.map(sha).filter((d) => emitted.has(d))]).toEqual([true, []]);
  }
}, 300_000);

test('a reading, a deck and a notebook Markdown cell with a script, a handler and a javascript: link give data without them', () => {
  for (const file of ['reading/methods.md', 'slides/transects.md', 'notebooks/counts.ipynb']) {
    const text = fs.readFileSync(join(sampling, file), 'utf8');
    expect(['<script', 'onerror', 'javascript:'].filter((s) => text.includes(s))).toHaveLength(3);
  }
  const data = [...main.files].filter(([path]) => path.startsWith('site/'));
  const hostile = data.filter(([, bytes]) => /<script|onerror|javascript:/i.test(String(bytes)));
  expect([data.length, hostile.map(([path]) => path)]).toEqual([11, []]);
});

test('buildCourse refuses what the reader and the upload rules refuse, and a PDF it cannot read, with the path and the message, and writes nothing', async () => {
  const [missing, refused, unread] = [copy('instructor'), copy('instructor'), copy('instructor')];
  // The reader's error stops the course before the upload rules see the empty data file.
  fs.rmSync(join(missing, 'courses/reef-ecology/sampling/slides/zones.pdf'));
  into(missing, 'notebooks/counts/data/empty.csv', '');
  const read = await build(missing);
  expect(said(errors(read.problems))).toEqual([
    'layout sampling/topic.yaml: no file sampling/slides/zones.pdf',
  ]);
  // The upload rules' errors stop it before conversion, which would refuse the PDF that is not.
  into(refused, 'reading/paper.pdf', Buffer.alloc(26 * 2 ** 20, '%PDF-'));
  into(refused, 'slides/zones.pdf', 'PK\u0003\u0004 a zip archive');
  into(refused, 'notebooks/counts.ipynb', '{"cells": [');
  into(refused, 'notebooks/counts/data/empty.csv', '');
  const upload = await build(refused);
  expect(said(errors(upload.problems))).toEqual([
    'upload sampling/notebooks/counts/data/empty.csv: The file is empty',
    'upload sampling/notebooks/counts.ipynb: The file is not a Jupyter notebook: it is not valid JSON',
    'upload sampling/slides/zones.pdf: The file is not a PDF',
    'upload sampling/reading/paper.pdf: The file is larger than 25 MB',
  ]);
  into(unread, 'reading/paper.pdf', '%PDF-1.4 and nothing a reader can parse');
  const pdf = await build(unread);
  const paper = 'sampling/reading/paper.pdf';
  expect(said(errors(pdf.problems))).toEqual([
    `unprocessed_reading ${paper}: “Counting fish along a transect” could not be processed; upload it again or retry`,
  ]);
  expect([read.files.size, upload.files.size, pdf.files.size]).toEqual([0, 0, 0]);
}, 300_000);

test('buildCourse refuses a notebook whose file for download would not pass openNotebookFile, naming the file, and writes nothing', async () => {
  const root = copy('instructor');
  // Unique ids that leave the renderer only an id past 64 characters for the last cell.
  const id = (n: number) => (n < 20 ? `cell-40${'-40'.repeat(n)}` : `f${n}`);
  const raw = { cell_type: 'raw', metadata: {}, source: '' };
  const cells = Array.from({ length: 41 }, (_, n) => (n < 40 ? { ...raw, id: id(n) } : raw));
  const notebook = { cells, metadata: {}, nbformat: 4, nbformat_minor: 4 };
  into(root, 'notebooks/counts.ipynb', JSON.stringify(notebook));
  const { problems, files } = await build(root);
  const why = 'The notebook file for download cannot be composed: Invalid string: must match';
  expect(said(errors(problems))).toEqual([
    `notebook sampling/notebooks/counts.ipynb: ${why} pattern /^[a-zA-Z0-9_-]{1,64}$/ (cells.40.id)`,
  ]);
  expect(files.size).toBe(0);
}, 120_000);

test('a conversion that fails gives a note with its own message, beside an error of the report, and writes nothing', async () => {
  const root = copy('instructor');
  // Over the 5 MB conversion reads of a native reading, under the 25 MB of the upload rules.
  into(root, 'reading/methods.md', `# Methods\n\n${'a'.repeat(6 * 2 ** 20)}\n`);
  const { problems, files } = await build(root);
  const methods = 'sampling/reading/methods.md';
  const own = problems.filter((p) => p.path === methods).map((p) => `${p.severity} ${p.message}`);
  // The note is conversion's own sentence, as the job records it, without the error's name.
  expect(own).toEqual([
    'note The file is larger than 5 MB',
    'error “Survey methods” could not be processed; upload it again or retry',
  ]);
  expect(files.size).toBe(0);
}, 120_000);

test('conversionIo refuses a file over its limit, a file changed since the reader read it, and a key that no file has', async () => {
  const root = copy('instructor');
  const methods = join(root, 'courses/reef-ecology/sampling/reading/methods.md');
  fs.writeFileSync(methods, `# Methods\n\n${'a'.repeat(2 ** 20)}\n`);
  const { manifest, open } = await readCourseForSite(join(root, 'courses/reef-ecology'));
  const { keys, bytes, io } = conversionIo(manifest?.files ?? [], open);
  const key = keys.get('sampling/reading/methods.md') ?? '';
  const whole = sha(fs.readFileSync(methods));
  expect([sha(await io.read(key, 2 * 2 ** 20)), sha(bytes.get(key) ?? Buffer.of())]).toEqual([
    whole,
    whole,
  ]);
  await expect(io.read(key, 2 ** 20)).rejects.toThrow('The file is larger than 1 MB');
  fs.appendFileSync(methods, 'changed');
  await expect(io.read(key, 2 * 2 ** 20)).rejects.toThrow('The file changed');
  const none = `open/objects/${'0'.repeat(64)}`;
  await expect(io.read(none, 2 ** 20)).rejects.toThrow('No file of the course has this key');
});

test('a topic with only an exercise and a test is built without empty_topic, and one with no shown resource keeps it', async () => {
  const { problems, files } = await build(copy('instructor'), 'courses/tide-pools', 'tide-pools');
  const { topics } = JSON.parse(String(files.get(at(openPaths.courseData('tide-pools')))));
  const none = { slides: false, reading: false, exercises: false, notebooks: false, tests: false };
  const practice = { ...none, exercises: true, tests: true };
  const shown = topics.map((t: { presence: object; firstTab: string }) => [t.presence, t.firstTab]);
  expect(shown).toEqual([
    [{ ...practice, reading: true, notebooks: true }, 'reading'],
    [practice, 'exercises'],
    [none, null],
  ]);
  const archive = '4f9a0b1c-2d3e-4f4a-8b5c-7d8e9f0a1b2c';
  expect(files.has(at(openPaths.topicData('tide-pools', archive)))).toBe(true);
  expect(lines(problems)).toEqual(['warning empty_topic archive/topic.yaml']);
}, 120_000);

test('the copy that vendor.ts writes holds content/convert.ts and content/reading.ts', () => {
  vendor(join(temp, 'packed'), resolve(import.meta.dirname, '../../../..'));
  const held = ['convert.ts', 'reading.ts', 'html-fragment.ts'];
  const content = join(temp, 'packed/vendor/server/src/content');
  expect(held.filter((file) => fs.existsSync(join(content, file)))).toEqual(held);
}, 60_000);

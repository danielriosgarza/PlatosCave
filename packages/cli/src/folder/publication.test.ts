import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CourseManifest } from '@parallax/contracts';
import { afterAll, expect, test, vi } from 'vitest';
import { LEFT_OUT } from '../commands/check';
import { main } from '../main';
import { loadSource } from '../paths';
import { type Conversion, publicationReport, uploadProblems } from './publication';

delete process.env.DATABASE_URL;
const fixtures = resolve(import.meta.dirname, '../../fixtures');
const course = 'courses/reef-ecology';
const site = fs.mkdtempSync(join(tmpdir(), 'parallax-publication-'));
afterAll(() => fs.rmSync(site, { recursive: true, force: true }));
const read = (): CourseManifest =>
  JSON.parse(fs.readFileSync(join(fixtures, 'course.manifest.json'), 'utf8'));
const [tides = '', sampling = ''] = read().topics.map((topic) => topic.id);
const folders = new Map([tides, sampling].map((id, i) => [id, i ? 'sampling' : 'tides']));
type Issue = { code: string; message: string; path?: string; overlay?: true };
type Report = { errors: Issue[]; warnings: Issue[] };
type Validation = { validate(drafts: unknown, options: object): Report };
const { validate } = await loadSource<Validation>('server', 'src/content/validation.ts');
const options = { approvedShinyOrigins: ['https://shiny.example.org'], folders };
type Entry = Record<string, unknown> & { source: Record<string, unknown> };
/** The entry of the second topic whose file is named `name`, to change. */
const entry = (manifest: CourseManifest, name: string) =>
  manifest.topics[1]?.resources.find((r) => r.path.endsWith(`/${name}`)) as unknown as Entry;
/** The drafts that publication loads for the same course, written out here: nothing converted. */
const drafts = (manifest: CourseManifest) =>
  manifest.topics.map(({ id, title, prerequisites = [], resources }) => ({
    topic: { id, title, prerequisites },
    resources: resources.map((r) => ({
      resource: { id: r.id, courseId: 'c', type: r.type, title: r.title },
      revision: {
        ...{ resourceId: r.id, courseId: 'c', type: r.type, derived: {} },
        content: 'definition' in r.source ? r.source.definition : r.source,
        accessibleAlternative: r.alternative ? { text: r.alternative } : null,
      },
      status: null,
    })),
  }));
const where = ({ errors, warnings }: Report) =>
  [...errors, ...warnings].map(({ code, path, overlay }) => `${code} ${overlay ? '+' : ''}${path}`);
// The fixture's Shiny app has no alternative: a warning in each report.
const shiny = 'missing_alternative sampling/notebooks/tide.shiny.yaml';

test('publicationReport gives each code that check reports as validate gives it for the same drafts, with its folder path, and nothing of a test’s publication rules', () => {
  const manifest = read();
  const [first, second] = manifest.topics;
  if (first) first.resources = [];
  if (second) second.prerequisites = ['00000000-0000-4000-8000-000000000000'];
  entry(manifest, 'estimate.yaml').source.definition = { schema: 'exercise.v1', steps: [] };
  entry(manifest, 'tide.shiny.yaml').source.url = 'https://apps.example.net/tide/';
  delete entry(manifest, 'deck.pdf').alternative;
  const quiz = entry(manifest, 'quiz.yaml').source.definition as { questions: object[] };
  const hidden = { name: 'hidden', kind: 'script', visibility: 'hidden', file: 'main.py' };
  quiz.questions[1] = { ...quiz.questions[1], checks: [hidden] };
  const report = publicationReport(manifest, undefined, options);
  // Publication's codes that check leaves out: a test's rules, and a conversion's.
  const left = 'invalid_test script_only_hidden_checks unconverted_deck unprocessed_reading';
  const same = (issues: Issue[]) => issues.filter(({ code }) => !left.split(' ').includes(code));
  const given = validate(drafts(manifest), { ...options, runtimes: [] });
  const plain = ({ path: _, overlay: __, ...issue }: Issue) => issue;
  expect(report.errors.map(plain)).toEqual(same(given.errors));
  expect(report.warnings.map(plain)).toEqual(same(given.warnings));
  // A test is checked against testV1 only: its runtime, which no server offers here, and its
  // hidden checks, all scripts now, give publication's issues and none in this report.
  const codes = [...given.errors, ...given.warnings].map((issue) => issue.code);
  expect(codes).toEqual(expect.arrayContaining(['invalid_test', 'script_only_hidden_checks']));
  expect(where(report)).toEqual([
    'broken_reference sampling/topic.yaml',
    'invalid_exercise +sampling/exercises/estimate.yaml',
    'empty_topic tides/topic.yaml',
    'missing_alternative sampling/slides/deck.pdf',
    'unapproved_shiny_origin sampling/notebooks/tide.shiny.yaml',
    shiny,
  ]);
  const none = validate([], { runtimes: [] }).errors.map((i) => ({ ...i, path: 'course.yaml' }));
  const empty = publicationReport({ ...manifest, topics: [] }, undefined, options);
  expect(empty).toEqual({ errors: none, warnings: [] });
});

test('conversion results add the two conversion codes and a raster-only deck’s missing alternative as an error; without them a PDF deck adds neither code', () => {
  const manifest = read();
  delete entry(manifest, 'deck.pdf').alternative;
  const [deck = '', methods = ''] = ['deck.pdf', 'methods.md'].map((f) => entry(manifest, f).id);
  const failed: Conversion = { state: 'failed' };
  const failing = { [String(methods)]: failed, [String(deck)]: failed };
  expect(where(publicationReport(manifest, failing, options))).toEqual([
    'unprocessed_reading sampling/reading/methods.md',
    'unconverted_deck sampling/slides/deck.pdf',
    'missing_alternative sampling/slides/deck.pdf',
    shiny,
  ]);
  const raster: Conversion = { state: 'ready', derived: { pages: [], rasterOnly: true } };
  const { errors } = publicationReport(manifest, { [String(deck)]: raster }, options);
  expect(where({ errors, warnings: [] })).toEqual(['missing_alternative sampling/slides/deck.pdf']);
  const without = where(publicationReport(manifest, undefined, options));
  expect(without).toEqual(['missing_alternative sampling/slides/deck.pdf', shiny]);
});

test('check refuses a 26 MiB PDF, a file with a NUL byte, an invalid notebook and unstorable text in a definition with the route’s sentences', async () => {
  fs.cpSync(join(fixtures, 'course'), site, { recursive: true });
  const topic = join(site, course, 'sampling');
  const answers = join(site, 'private', course, 'sampling');
  fs.writeFileSync(join(topic, 'reading/paper.pdf'), Buffer.alloc(26 * 2 ** 20, '%PDF-'));
  fs.appendFileSync(join(topic, 'reading/methods.md'), '\0');
  fs.writeFileSync(join(topic, 'notebooks/counts.ipynb'), '{"cells": [');
  fs.appendFileSync(join(answers, 'tests/quiz/q3/main.py'), '\0');
  const estimate = join(answers, 'exercises/estimate.yaml');
  const text = fs.readFileSync(estimate, 'utf8');
  fs.writeFileSync(estimate, text.replace('Count the quadrats again.', '"Count again\\ud800"'));
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line));
  expect(await main(['check'], { cwd: site }).finally(() => log.mockRestore())).toBe(1);
  const unstorable = 'The text holds a NUL or an unpaired surrogate';
  expect(lines).toEqual(
    expect.arrayContaining([
      `${course}/sampling/reading/paper.pdf: The file is larger than 25 MB`,
      `${course}/sampling/reading/methods.md: The file is not text`,
      `${course}/sampling/notebooks/counts.ipynb: The file is not a Jupyter notebook: it is not valid JSON`,
      `private/${course}/sampling/tests/quiz.yaml: ${unstorable}`,
      `private/${course}/sampling/exercises/estimate.yaml: ${unstorable}`,
      // Publication's report and the note on what check leaves out are printed as well.
      `warning: ${course}/sampling/notebooks/tide.shiny.yaml: “Tide explorer” has no accessible alternative`,
      LEFT_OUT,
    ]),
  );
});

test('the data files of a notebook: at most 100, each at a workspace path, refused with the route’s sentences', async () => {
  const open = (file: string) => fs.createReadStream(join(fixtures, 'course', course, file));
  const refused = async (data: string[]) => {
    const manifest = read();
    entry(manifest, 'counts.ipynb').source.data = data.map((path) => ({ path, file: path }));
    const problems = await uploadProblems(manifest, open, folders);
    return problems.map(({ path, message }) => `${path}: ${message}`);
  };
  const many = Array.from({ length: 101 }, (_, i) => `data/${i}.csv`);
  const notebook = 'sampling/notebooks/counts.ipynb';
  expect(await refused(many)).toEqual([`${notebook}: A notebook declares at most 100 files`]);
  expect(await refused(many.slice(1))).toEqual([]);
  const why = '“data\\counts.csv” is no relative path without empty, dot or hidden segments';
  expect(await refused(['data\\counts.csv'])).toEqual([`${notebook}: ${why}`]);
});

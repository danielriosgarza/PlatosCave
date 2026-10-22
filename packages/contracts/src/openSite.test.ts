import { expect, test } from 'vitest';
import type { z } from 'zod';
import { parseNotebook } from './notebook';
import * as open from './openSite';
import { shinyAddressProblem } from './shiny';

/** The fields a schema refuses in a value; an unknown key is named as a field of its object. */
const refused = (schema: z.ZodType, value: unknown): string[] =>
  (schema.safeParse(value).error?.issues ?? []).flatMap((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => [...issue.path, key].join('.'))
      : [issue.path.join('.')],
  );
type Path = (string | number)[];
/** The path of every object in a value, the value's own first; nothing below a key of `skip`. */
function objects(value: unknown, skip: string[] = [], path: Path = []): Path[] {
  if (typeof value !== 'object' || value === null) return [];
  const list = Array.isArray(value);
  const below = Object.entries(value).flatMap(([key, inner]) =>
    skip.includes(key) ? [] : objects(inner, skip, [...path, list ? Number(key) : key]),
  );
  return list ? below : [path, ...below];
}
/** A copy of a value in which the object at `path`, and no other, also has the fields of `more`. */
function withFields<T extends object>(value: T, path: Path, more: object): T {
  const copy = JSON.parse(JSON.stringify(value)) as T;
  const at = path.reduce<unknown>((o, step) => (o as Record<string, unknown>)[step], copy);
  Object.assign(at as object, more);
  return copy;
}
const PLANTED = 'planted-under-a-key-no-schema-names';
const planted = (keys: string[]) => Object.fromEntries(keys.map((key) => [key, PLANTED]));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const object = (name: string) => `https://content.example.org/o/${name}`;
const courses = [{ ref: 'ana/reef-ecology', title: 'Reef ecology' }];
const catalogue = { mode: 'school', instructors: [{ name: 'Ana Reyes', courses }] };
const presence = { slides: true, reading: true, exercises: true, notebooks: true, tests: false };
const objective = 'Plan a transect survey and say what its counts can show.';
const first = { topicId: id(1), number: 1, title: 'Sampling a reef', objective, presence };
const topics = [{ ...first, estimatedMinutes: 90, firstTab: 'slides' }];
const course = { title: 'Reef ecology', instructors: ['Ana Reyes'], topics };
const listed = { resourceId: id(2), title: 'Transect surveys' };
const topic = {
  slides: [listed],
  reading: [{ ...listed, kind: 'native' }],
  notebooks: ['notebook', 'shiny'].map((type) => ({ ...listed, type })),
  exercises: [listed],
  tests: [listed],
};
const none = { executionCount: null };
const row = (text: string, header: boolean) => [{ text, header }];
/** One output of each kind the view links or renders, and one of plain text. */
const outputs = [
  { type: 'text', executionCount: 1, stream: null, text: '12.0', truncated: false },
  { ...none, type: 'image', url: object('bb.png'), alt: 'Histogram' },
  { ...none, type: 'html', url: null, height: 80, scriptsRemoved: true },
  { ...none, type: 'table', caption: null, head: [row('site', true)], body: [], notes: [] },
  { ...none, type: 'markdown', html: '<p>Mean count</p>' },
];
const shown = { sourceHidden: false, outputsHidden: false, outputs };
const notebook = {
  kernel: 'Python 3',
  language: 'python',
  outline: [{ cellId: 'intro', level: 1, text: 'Counts' }],
  cells: [
    { id: 'intro', type: 'markdown', html: '<h1>Counts</h1>' },
    { id: 'note', type: 'raw', text: 'Counted at low tide.' },
    { id: 'draw', type: 'code', source: 'counts.mean()', executionCount: 1, ...shown },
  ],
};
const pdf = { url: object('aa.pdf'), pageCount: 12 };
const title = 'Counting fish';
const tide = 'https://shiny.example.org/tide/';
const resources = {
  slides: { type: 'slides', title, pdf, web: { slides: ['<h1>Transects</h1>'] } },
  reading: { type: 'reading', title, kind: 'pdf', html: null, pdf },
  notebook: { type: 'notebook', title, file: object('dd.ipynb'), data: object('ee.zip'), notebook },
  shiny: { type: 'shiny', title, url: tide, origin: 'https://shiny.example.org' },
};
const unrun = { execution_count: null, outputs: [] };
/** The notebook above as it is composed for download (design §3). */
const download = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { language_info: { name: 'python' } },
  cells: [
    { id: 'intro', cell_type: 'markdown', metadata: {}, source: '<h1>Counts</h1>' },
    { id: 'note', cell_type: 'raw', metadata: {}, source: 'Counted at low tide.' },
    { id: 'draw', cell_type: 'code', metadata: {}, source: 'counts.mean()', ...unrun },
  ],
};
const valid: [name: string, schema: z.ZodType, value: object][] = [
  ['openCatalogue', open.openCatalogue, catalogue],
  ['openCourse', open.openCourse, course],
  ['openTopic', open.openTopic, topic],
  ['a deck', open.openResource, resources.slides],
  ['a reading', open.openResource, resources.reading],
  ['a notebook', open.openResource, resources.notebook],
  ['a Shiny app', open.openResource, resources.shiny],
  ['openNotebookFile', open.openNotebookFile, download],
];
/** What no data file may hold (design §5), as the keys that would carry it. */
const account = 'email revisionId position releaseAt credit sourceKey expiresAt';
const answers = 'definition steps questions answer feedback hints solution checks rubric files';
const HIDDEN = `${account} ${answers}`.split(' ');

test.each(valid)('%s parses, and refuses one more key at a strict level', (_, schema, value) => {
  expect(schema.parse(value)).toEqual(value);
  for (const path of objects(value, ['notebook'])) {
    for (const key of HIDDEN) {
      const named = refused(schema, withFields(value, path, planted([key])));
      expect(named).toEqual([[...path, key].join('.')]);
    }
  }
});

test('a value parses without a file, a time, a first tab, an origin or a language', () => {
  const bare = [{ ...first, estimatedMinutes: null, firstTab: null }];
  expect(refused(open.openCourse, { ...course, instructors: [], topics: bare })).toEqual([]);
  expect(refused(open.openCatalogue, { mode: 'instructor', instructors: [] })).toEqual([]);
  const empty = { slides: [], reading: [], notebooks: [], exercises: [], tests: [] };
  expect(refused(open.openTopic, empty)).toEqual([]);
  const native = { ...resources.reading, kind: 'native', html: '<p>Counts</p>', pdf: null };
  const local = { ...resources.shiny, url: 'http://localhost:3838/', origin: null };
  for (const resource of [{ ...resources.slides, pdf: null }, native, local]) {
    expect(refused(open.openResource, resource)).toEqual([]);
  }
  expect(refused(open.openNotebookFile, { ...download, metadata: {}, cells: [] })).toEqual([]);
  // The composed file is a notebook that the import contract accepts.
  expect(parseNotebook(JSON.stringify(open.openNotebookFile.parse(download))).ok).toBe(true);
});

test('an exercise or a test is a title in a list: no other field, and no resource file', () => {
  const lists = (change: object) => refused(open.openTopic, { ...topic, ...change });
  expect(lists({ exercises: [{ ...listed, kind: 'native' }] })).toEqual(['exercises.0.kind']);
  expect(lists({ tests: [{ ...listed, type: 'notebook' }] })).toEqual(['tests.0.type']);
  expect(lists({ tests: [{ resourceId: 'quiz', title }] })).toEqual(['tests.0.resourceId']);
  expect(lists({ exams: [listed] })).toEqual(['exams']);
  const file = (type: string) => ({ type, title, definition: { steps: [] } });
  const types = ['exercise', 'test', 'slides_pdf'];
  const named = types.flatMap((type) => refused(open.openResource, file(type)));
  expect(named).toEqual(['type', 'type', 'type']);
});

test.each([
  ['a javascript: address', 'javascript:alert(1)'],
  ['http on a host that is not loopback', 'http://shiny.example.org/tide/'],
  ['an address with a password', 'https://ana:secret@shiny.example.org/tide/'],
  ['no address', 'tide'],
])('a Shiny app at %s is refused, with the reason of the address rule', (_what, url) => {
  const app = { ...resources.shiny, url, origin: null };
  expect(refused(open.openResource, app)).toEqual(['url']);
  expect(open.openResource.safeParse(app).error?.issues[0]?.message).toBe(shinyAddressProblem(url));
});

test('an origin that is not the origin of its Shiny address is refused', () => {
  const others = ['https://other.example.org', 'http://shiny.example.org', tide, 'null', ''];
  for (const origin of others) {
    expect(refused(open.openResource, { ...resources.shiny, origin })).toEqual(['origin']);
  }
});

test('the address of an object is an http or https address', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'o/aa']) {
    const deck = { ...resources.slides, pdf: { ...pdf, url } };
    expect(refused(open.openResource, deck)).toEqual(['pdf.url']);
    expect(refused(open.openResource, { ...resources.notebook, file: url })).toEqual(['file']);
    expect(refused(open.openResource, { ...resources.notebook, data: url })).toEqual(['data']);
  }
  // A notebook that declares no data file has no zip.
  expect(refused(open.openResource, { ...resources.notebook, data: null })).toEqual([]);
  const local = { ...resources.notebook, file: 'http://localhost:4176/o/dd.ipynb' };
  expect(refused(open.openResource, local)).toEqual([]);
});

test('the parse result of a notebook holds no key that the view does not name', () => {
  const stored = planted(['key', 'contentType', 'expiresAt', 'solution']);
  const add = (value: object, path: Path) => withFields(value, ['notebook', ...path], stored);
  const carrying = objects(notebook).reduce(add, resources.notebook);
  // The notebook, its heading, three cells, five outputs and a table cell each carry the four.
  expect(JSON.stringify(carrying).split(PLANTED)).toHaveLength(11 * 4 + 1);
  const parsed = open.openResource.parse(carrying);
  expect(parsed).toEqual(resources.notebook);
  expect(JSON.stringify(parsed)).not.toContain(PLANTED);
});

const stream = { output_type: 'stream', name: 'stdout', text: '12.0' };
test.each<[field: string, path: Path, more: object]>([
  ['cells.2.outputs', ['cells', 2], { outputs: [stream] }],
  ['cells.2.execution_count', ['cells', 2], { execution_count: 1 }],
  ['cells.0.attachments', ['cells', 0], { attachments: {} }],
  ['cells.0.outputs', ['cells', 0], { outputs: [] }],
  ['cells.1.metadata.jupyter', ['cells', 1, 'metadata'], { jupyter: { source_hidden: true } }],
  ['cells.1.source', ['cells', 1], { source: ['Counted at low tide.'] }],
  ['cells.1.id', ['cells', 1], { id: 'a note' }],
  ['metadata.kernelspec', ['metadata'], { kernelspec: { name: 'python3' } }],
  ['metadata.language_info.version', ['metadata', 'language_info'], { version: '3.12' }],
  ['nbformat_minor', [], { nbformat_minor: 4 }],
])('openNotebookFile refuses %s: no output, attachment or other metadata', (field, path, more) => {
  expect(refused(open.openNotebookFile, withFields(download, path, more))).toEqual([field]);
});

test('courseRef and openPaths give the reference and the addresses, each name percent-encoded', () => {
  expect(open.courseRef('instructor', 'ana', 'reef-ecology')).toBe('reef-ecology');
  expect(open.courseRef('school', 'ana', 'reef-ecology')).toBe('ana/reef-ecology');
  const paths = open.openPaths;
  expect(paths.courseData('Reef ecology')).toBe('/courses/Reef%20ecology/course.json');
  expect(paths.catalogue).toBe('/courses/catalogue.json');
  expect(paths.course('ana/Reef ecology')).toBe('/courses/ana/Reef%20ecology');
  expect(paths.course('50% #1?')).toBe('/courses/50%25%20%231%3F');
  const ref = 'ana/reef-ecology';
  expect(paths.topic(ref, id(1), 'reading')).toBe(`/courses/${ref}/${id(1)}/reading`);
  expect(paths.topicData(ref, id(1))).toBe(`/courses/${ref}/${id(1)}/topic.json`);
  expect(paths.resourceData(ref, id(1), id(2))).toBe(`/courses/${ref}/${id(1)}/${id(2)}.json`);
  expect(paths.topicData(ref, 'a/b')).toBe(`/courses/${ref}/a%2Fb/topic.json`);
  const below = ['', '/$a', '/$a/$b', '/$a/$b/$c', '/$a/$b/$c/$d'];
  expect(open.OPEN_ADDRESSES).toEqual(below.map((rest) => `/courses${rest}`));
});

test('objectExtension gives the eight extensions, and nothing for any other type', () => {
  const table = {
    'application/pdf': 'pdf',
    'application/x-ipynb+json': 'ipynb',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'text/html; charset=utf-8': 'html',
  };
  expect(Object.keys(table).map(open.objectExtension)).toEqual(Object.values(table));
  const script = 'application/javascript|text/javascript|text/html|application/octet-stream';
  const spelled = 'TEXT/HTML; CHARSET=UTF-8|text/html;charset=utf-8|image/png |constructor|';
  const others = `${script}|${spelled}`.split('|');
  expect(others.filter((type) => open.objectExtension(type) !== undefined)).toEqual([]);
  expect(others).toHaveLength(9);
});

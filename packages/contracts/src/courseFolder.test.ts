import { expect, test } from 'vitest';
import type { z } from 'zod';
import * as folder from './courseFolder';
import { exerciseV1 } from './exercise';
import { testV1 } from './test';

/** The fields a schema refuses in a value; an unknown key is named as a field of its object. */
const refused = (schema: z.ZodType, value: unknown): string[] =>
  (schema.safeParse(value).error?.issues ?? []).flatMap((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => [...issue.path, key].join('.'))
      : [issue.path.join('.')],
  );
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const long = (length: number) => 'x'.repeat(length);
const course = { title: 'Reef ecology', public: true };
/** The `topic.yaml` of design §3; its entries have the ids of resources 0, 3 and 7 below. */
const topic = () => ({
  id: id(100),
  position: 1,
  title: 'Sampling a reef',
  objective: 'Plan a transect survey and say what its counts can show.',
  estimatedMinutes: 90,
  prerequisites: [id(101)],
  completionRule: { requires: ['reviewed:*', `submitted:${id(7)}`] },
  resources: [
    { id: id(0), file: 'slides/transects.md', title: 'Transect surveys' },
    { id: id(3), file: 'reading/paper.pdf', title: 'Counting fish', visibility: 'hidden' },
    { id: id(7), file: 'tests/quiz.yaml', title: 'Sampling quiz' },
  ],
});
/** The topic with its first entry changed. */
const entry = (change: object) => ({
  resources: topic().resources.map((r, i) => (i === 0 ? { ...r, ...change } : r)),
});
const decks = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ file: `slides/s${i}.md`, title: `Deck ${i}` }));

test.each<[file: 'course' | 'topic', field: string, change: object]>([
  ['course', 'title', { title: long(161) }],
  ['course', 'title', { title: ' ' }],
  ['course', 'public', { public: undefined }],
  ['course', 'public', { public: 'yes' }],
  ['course', 'id', { id: id(1) }],
  ['topic', 'id', { id: 'ABCDEF00-0000-4000-8000-000000000100' }],
  ['topic', 'position', { position: undefined }],
  ['topic', 'position', { position: -1 }],
  ['topic', 'position', { position: 1.5 }],
  ['topic', 'title', { title: long(301) }],
  ['topic', 'objective', { objective: long(2001) }],
  ['topic', 'estimatedMinutes', { estimatedMinutes: -1 }],
  ['topic', 'estimatedMinutes', { estimatedMinutes: 10_001 }],
  ['topic', 'prerequisites', { prerequisites: Array.from({ length: 51 }, (_, i) => id(i)) }],
  ['topic', 'prerequisites.0', { prerequisites: ['tides'] }],
  ['topic', 'completionRule.requires.0', { completionRule: { requires: ['graded:*'] } }],
  ['topic', 'completionRule.requires.0', { completionRule: { requires: [`submitted:${id(9)}`] } }],
  ['topic', 'completionRule.optional', { completionRule: { requires: [], optional: true } }],
  ['topic', 'releaseAt', { releaseAt: '2026-11-01T09:00:00Z' }],
  ['topic', 'resources', { resources: [...topic().resources, ...decks(198)] }],
  ['topic', 'resources.3.file', { resources: [...topic().resources, topic().resources[0]] }],
  ['topic', 'resources.0.id', entry({ id: 'transects' })],
  ['topic', 'resources.0.file', entry({ file: 'data/quadrats.csv' })],
  ['topic', 'resources.0.file', entry({ file: 'slides/2026/transects.md' })],
  ['topic', 'resources.0.file', entry({ file: 'slides/transects.txt' })],
  ['topic', 'resources.0.title', entry({ title: long(301) })],
  ['topic', 'resources.0.visibility', entry({ visibility: 'secret' })],
  ['topic', 'resources.0.alternative', entry({ alternative: ' ' })],
  ['topic', 'resources.0.alternative', entry({ alternative: long(20_001) })],
  ['topic', 'resources.0.releaseAt', entry({ releaseAt: '2026-11-01T09:00:00Z' })],
])('%s.yaml refuses %s, and names it', (file, field, change) => {
  const [schema, value] =
    file === 'course' ? [folder.courseMeta, course] : [folder.topicMeta, topic()];
  expect(refused(schema, value)).toEqual([]);
  expect(refused(schema, { ...value, ...change })).toEqual([field]);
});

test('both files take every field at its limit, and a topic whose ids are still to be written', () => {
  expect(folder.courseMeta.parse({ title: ` ${long(160)} `, public: false }).title).toBe(long(160));
  const widest = {
    position: 0,
    title: long(300),
    objective: long(2000),
    estimatedMinutes: 10_000,
    prerequisites: Array.from({ length: 50 }, (_, i) => id(i)),
    completionRule: { requires: ['submitted:*'] },
    resources: decks(200).map((deck) => ({ ...deck, alternative: long(20_000) })),
  };
  expect(refused(folder.topicMeta, widest)).toEqual([]);
  const visibilities = folder.topicMeta.parse(topic()).resources.map((r) => r.visibility);
  expect(visibilities).toEqual(['visible', 'hidden', 'visible']);
  const unknown = folder.topicMeta.safeParse({ ...topic(), ...entry({ visibility: 'secret' }) });
  expect(unknown.error?.issues[0]?.message).toBe('expected "visible" or "hidden"');
});

test.each<[type: string, paths: string[]]>([
  ['slides_web', ['slides/transects.md', 'slides/TRANSECTS.MARKDOWN']],
  ['slides_pdf', ['slides/Deck.PDF']],
  ['reading_native', ['reading/methods.MD', 'reading/methods.Markdown', 'reading/Page.HTML']],
  ['reading_pdf', ['reading/paper.Pdf']],
  ['notebook', ['notebooks/counts.IPYNB']],
  ['shiny', ['notebooks/tide.Shiny.YAML']],
  ['exercise', ['exercises/estimate.YAML']],
  ['test', ['tests/quiz.yaml']],
])('the layout table gives %s for its row, whatever the case of the extension', (type, paths) => {
  expect(paths.map(folder.resourceKindOf)).toEqual(paths.map(() => type));
});

test('a path outside the layout table is no resource', () => {
  const kinds = 'slides/page.html reading/notes.htm reading/counts.ipynb notebooks/tide.yaml';
  const names = 'exercises/estimate.yml tests/quiz/q3/main.py slides/_draft.md slides/.md slides/';
  const places = 'data/transects.md Slides/transects.md transects.md /slides/transects.md';
  const paths = `${kinds} ${names} ${places}`.split(' ');
  expect(paths.filter((path) => folder.resourceKindOf(path) !== undefined)).toEqual([]);
});

const step = { id: 'estimate', kind: 'numeric', title: 'Estimate', prompt: 'Fish per transect?' };
const feedback = { correct: 'Yes.', incorrect: 'Count again.' };
const exercise = {
  schema: 'exercise.v1',
  steps: [{ ...step, answer: 12, tolerance: 1, feedback }],
};
const question = { id: 'q1', kind: 'numeric', prompt: 'Mean count?', points: 2 };
const quiz = { questions: [{ ...question, answer: 12, tolerance: 1 }] };
const csv = { path: 'data/quadrats.csv', file: 'notebooks/counts/data/quadrats.csv' };
/** One resource of each of the eight types: its path and its source. */
const sources: [type: string, path: string, source: object][] = [
  ['slides_web', 'slides/transects.md', { markdown: '# Transects\n\n---\n\n# Counts\n' }],
  ['slides_pdf', 'slides/deck.pdf', { file: 'slides/deck.pdf' }],
  ['reading_native', 'reading/methods.md', { file: 'reading/methods.md' }],
  ['reading_pdf', 'reading/paper.pdf', { file: 'reading/paper.pdf' }],
  ['notebook', 'notebooks/counts.ipynb', { file: 'notebooks/counts.ipynb', data: [csv] }],
  ['shiny', 'notebooks/tide.shiny.yaml', { url: 'https://shiny.example.org/tide/' }],
  ['exercise', 'exercises/estimate.yaml', { definition: exercise }],
  ['test', 'tests/quiz.yaml', { definition: quiz }],
];
const sha256 = 'ab'.repeat(32);
/** The course as the reader hands it to the operator, with one resource changed. */
const manifest = (index = 0, change: object = {}) => ({
  ...course,
  topics: [
    {
      ...topic(),
      resources: sources.map(([type, path, source], i) => {
        const overlay = 'definition' in source;
        const resource = {
          id: id(i),
          type,
          title: path,
          visibility: 'visible',
          path,
          overlay,
          source,
        };
        return i === index ? { ...resource, ...change } : resource;
      }),
    },
  ],
  files: [
    { path: csv.file, format: 'data', size: 9, sha256 },
    { path: 'notebooks/counts.ipynb', format: 'notebook', size: 90, sha256 },
  ],
});
/** The same course as a site build receives it, with one resource changed. */
function site(index = 0, change: object = {}) {
  const { title, topics, files } = manifest();
  const shown = topics.map(({ completionRule: _, resources, ...rest }) => ({
    ...rest,
    resources: resources
      .map(({ overlay, ...r }) => (overlay ? { id: r.id, type: r.type, title: r.title } : r))
      .map((r, i) => ({ visibility: 'visible', ...r, ...(i === index && change) })),
  }));
  return { title, topics: shown, files };
}
const key = (path: string) => `courses/c/objects/${path}`;
const keyOnly = (path: string) => ({ key: key(path) });
const object = (path: string) => ({ key: key(path), id: `object of ${path}`, size: path.length });

test('revisionPayload gives for each of the eight types the body the editor stores', () => {
  const resources = folder.courseManifest.parse(manifest()).topics.flatMap((t) => t.resources);
  const bodies = resources.map((resource) => folder.revisionPayload(resource, object));
  const types = bodies.map((body) => [body.type, body.accessibleAlternative]);
  expect(types).toEqual(sources.map(([type]) => [type, null]));
  const [deck, methods, paper, counts] = [1, 2, 3, 4].map((i) => key(sources[i]?.[1] ?? ''));
  const workspaceFiles = [{ path: csv.path, resourceId: `object of ${csv.file}`, size: 34 }];
  expect(bodies.map((body) => [body.content, body.objectKeys])).toEqual([
    [{ markdown: '# Transects\n\n---\n\n# Counts\n' }, []],
    [{ objectKey: deck }, [deck]],
    [{ sourceKey: methods, format: 'markdown' }, [methods]],
    [{ objectKey: paper }, [paper]],
    [{ sourceKey: counts, workspaceFiles }, [counts, key(csv.file)]],
    [{ url: 'https://shiny.example.org/tide/' }, []],
    [exerciseV1.parse(exercise), []],
    [testV1.parse(quiz), []],
  ]);
});

test('revisionPayload: an HTML reading, an alternative, a notebook without data files', () => {
  const page = { type: 'reading_native', source: { file: 'reading/Page.HTML' } } as const;
  const described = folder.revisionPayload({ ...page, alternative: 'Each table.' }, object);
  expect(described.content).toEqual({ sourceKey: key('reading/Page.HTML'), format: 'html' });
  expect(described.accessibleAlternative).toEqual({ text: 'Each table.' });
  const counts = { file: 'notebooks/counts.ipynb', data: [] as (typeof csv)[] };
  const alone = folder.revisionPayload({ type: 'notebook', source: counts }, keyOnly);
  expect(alone.content).toEqual({ sourceKey: key(counts.file) });
  expect(alone.objectKeys).toEqual([key(counts.file)]);
  // A data file needs the id and the size of its stored object.
  const withData = { type: 'notebook' as const, source: { ...counts, data: [csv] } };
  expect(() => folder.revisionPayload(withData, keyOnly)).toThrow(csv.file);
});

test('a deck saved with a byte-order mark and CRLF gives the body of the deck saved with LF', () => {
  const deck = (markdown: string) =>
    folder.revisionPayload({ type: 'slides_web', source: { markdown } }, object);
  const saved = `${String.fromCharCode(0xfeff)}# Transects\r\n\r\n---\r\n\r\n# Counts\r\n`;
  expect(deck(saved)).toEqual(deck('# Transects\n\n---\n\n# Counts\n'));
  expect(deck(saved).content).toEqual({ markdown: '# Transects\n\n---\n\n# Counts\n' });
});

test('topicPayload gives prerequisites and { requires } with the row ids a stand-in gives', () => {
  const rowId = (kind: string, folderId: string) => `${kind} row of ${folderId}`;
  expect(folder.topicPayload(folder.topicMeta.parse(topic()), rowId)).toEqual({
    position: 1,
    title: 'Sampling a reef',
    objective: 'Plan a transect survey and say what its counts can show.',
    estimatedMinutes: 90,
    prerequisites: [`topic row of ${id(101)}`],
    completionRule: { requires: ['reviewed:*', `submitted:resource row of ${id(7)}`] },
  });
  const tides = { position: 0, title: 'Tides' };
  const empty = { ...tides, objective: '', estimatedMinutes: null, prerequisites: [] };
  expect(folder.topicPayload(tides, rowId)).toEqual({ ...empty, completionRule: null });
  const all = { requires: ['submitted:*'] };
  const ruled = folder.topicPayload({ ...tides, completionRule: all }, rowId);
  expect(ruled).toEqual({ ...empty, completionRule: all });
});

test('the course manifest and the sync header hold every resource with its source', () => {
  const parsed = folder.courseManifest.parse(manifest());
  const [estimate, sampling] = parsed.topics.flatMap((t) => t.resources.slice(6));
  expect(estimate?.source).toEqual({ definition: exerciseV1.parse(exercise) });
  expect(sampling?.source).toEqual({ definition: testV1.parse(quiz) });
  expect(refused(folder.courseManifest, { ...manifest(), mode: 'school' })).toEqual(['mode']);
  const at = 'topics.0.resources';
  const kernel = { source: { file: 'notebooks/counts.ipynb', data: [], kernel: 'python3' } };
  expect(refused(folder.courseManifest, manifest(4, kernel))).toEqual([`${at}.4.source.kernel`]);
  const stepless = { source: { definition: { ...exercise, steps: [] } } };
  expect(refused(folder.courseManifest, manifest(6, stepless))).toEqual([
    `${at}.6.source.definition.steps`,
  ]);
  const options = { overwriteEditor: false, acceptNewIds: true };
  const instructor = { email: 'ana.lima@example.org', path: 'instructor.yaml' };
  const header = { instructor, course: 'reef-ecology', manifest: manifest(), options };
  expect(folder.syncHeader.parse(header).manifest).toEqual(parsed);
  const forced = { ...header, options: { ...options, force: true } };
  expect(refused(folder.syncHeader, forced)).toEqual(['options.force']);
  expect(refused(folder.syncHeader, { ...header, course: '' })).toEqual(['course']);
});

test('a site manifest refuses a definition, a hidden resource and a topic’s completion rule', () => {
  const at = 'topics.0.resources.';
  const refuses = (index?: number, change?: object) =>
    refused(folder.siteManifest, site(index, change)).map((field) => field.replace(at, ''));
  expect(refuses()).toEqual([]);
  // An entry that has a source gives the same body as in the course manifest.
  const shown = folder.siteManifest.parse(site()).topics.flatMap((t) => t.resources);
  const types = shown.flatMap((r) =>
    'source' in r ? [folder.revisionPayload(r, object).type] : [],
  );
  expect(types).toEqual(sources.slice(0, 6).map(([type]) => type));
  expect(refuses(6, { source: { definition: exercise } })).toEqual(['6.source']);
  expect(refuses(7, { definition: quiz })).toEqual(['7.definition']);
  expect(refuses(7, { path: 'tests/quiz.yaml' })).toEqual(['7.path']);
  expect(refuses(0, { visibility: 'hidden' })).toEqual(['0.visibility']);
  expect(refuses(6, { visibility: 'hidden' })).toEqual(['6.visibility']);
  const ruled = site();
  Object.assign(ruled.topics[0] ?? {}, { completionRule: { requires: ['reviewed:*'] } });
  expect(refused(folder.siteManifest, ruled)).toEqual(['topics.0.completionRule']);
  expect(refused(folder.siteManifest, manifest())).toContain('public');
});

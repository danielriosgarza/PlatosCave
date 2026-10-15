import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exerciseV1, revisionPayload, testV1, topicPayload } from '@parallax/contracts';
import { afterAll, expect, test } from 'vitest';
import { parse } from 'yaml';
import { readCourseForSync } from './folder/read';

delete process.env.DATABASE_URL;
const fixtures = resolve(import.meta.dirname, '../fixtures');
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-a40-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
const course = 'courses/reef-ecology';
const site = join(fixtures, 'course');
const text = (file: string, from = site) => fs.readFileSync(join(from, file), 'utf8');
const golden = (name: string) => JSON.parse(text(`${name}.manifest.json`, fixtures));
/** The course of a site, read with its overlay. */
const read = (at: string) =>
  readCourseForSync(join(at, course), { overlay: join(at, 'private', course) });
let copies = 0;
/** The fixture site in a temporary folder, with one file of the course written. */
function copy(file: string, change: (text: string) => string): string {
  const at = join(temp, `copy-${copies++}`);
  fs.cpSync(site, at, { recursive: true });
  const path = join(at, course, file);
  fs.writeFileSync(path, change(fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : ''));
  return at;
}
const tides = '0b2f4a6c-8d1e-4f3a-b5c7-9e0a1b2c3d4e';
const sampling = '5f0c1d8e-3b7a-4c2e-9a41-7d2f6b0e1c33';
const quiz = '8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d';

test('A40 each file of a course folder maps to the type, order, title and stored content the editor records', async () => {
  const { manifest, problems } = await read(site);
  expect(problems).toEqual([]);
  expect(manifest).toEqual(golden('course'));
  const topics = manifest?.topics ?? [];
  // Topics by position, not by their folders' names; resources in the order topic.yaml lists.
  expect(topics.map((topic) => topic.id)).toEqual([tides, sampling]);
  type Listed = { id: string; title: string; alternative?: string };
  const listed = ['tides', 'sampling'].flatMap(
    (topic) => parse(text(`${course}/${topic}/topic.yaml`)).resources as Listed[],
  );
  const resources = topics.flatMap((topic) => topic.resources);
  expect(resources.map((r) => [r.id, r.title])).toEqual(listed.map((r) => [r.id, r.title]));

  // One resource of each of the eight types, each stored as the body the editor's form posts.
  const key = (file: string) => `key of ${file}`;
  const stored = (file: string) => ({ key: key(file), id: `object of ${file}`, size: 21 });
  const s = (file: string) => `sampling/${file}`;
  const hidden = (file: string) => text(`private/${course}/sampling/${file}`);
  const quizYaml = parse(hidden('tests/quiz.yaml'));
  quizYaml.questions[1].files[0].content = hidden('tests/quiz/q3/main.py');
  quizYaml.questions[1].files[1].content = hidden('tests/quiz/q3/tests/check.py');
  const [html, methods] = ['tides/reading/tides.html', s('reading/methods.md')] as const;
  const [counts, csv] = [
    s('notebooks/counts.ipynb'),
    s('notebooks/counts/data/quadrats.csv'),
  ] as const;
  const workspaceFiles = [{ path: 'data/quadrats.csv', resourceId: `object of ${csv}`, size: 21 }];
  const reading = (path: string, format: string) => ({ sourceKey: key(path), format });
  const pdf = (path: string) => ({ objectKey: key(path) });
  const bodies: [type: string, content: unknown, objects: string[]][] = [
    ['reading_native', reading(html, 'html'), [html]],
    ['slides_web', { markdown: text(`${course}/sampling/slides/transects.md`) }, []],
    ['reading_native', reading(methods, 'markdown'), [methods]],
    ['notebook', { sourceKey: key(counts), workspaceFiles }, [counts, csv]],
    ['exercise', exerciseV1.parse(parse(hidden('exercises/estimate.yaml'))), []],
    ['slides_pdf', pdf(s('slides/deck.pdf')), [s('slides/deck.pdf')]],
    ['shiny', { url: 'https://shiny.example.org/tide/' }, []],
    ['reading_pdf', pdf(s('reading/paper.pdf')), [s('reading/paper.pdf')]],
    ['test', testV1.parse(quizYaml), []],
  ];
  expect(resources.map((resource) => revisionPayload(resource, stored))).toEqual(
    bodies.map(([type, content, objects], i) => {
      const alternative = listed[i]?.alternative;
      const accessibleAlternative = alternative ? { text: alternative } : null;
      return { type, content, objectKeys: objects.map(key), accessibleAlternative };
    }),
  );
  expect(new Set(resources.map((resource) => resource.type)).size).toBe(8);
  // Both kinds of reference become row ids, as the topic form stores them.
  const rowId = (kind: string, id: string) => `${kind} row of ${id}`;
  expect(topics[1] && topicPayload(topics[1], rowId)).toMatchObject({
    prerequisites: [`topic row of ${tides}`],
    completionRule: { requires: ['reviewed:*', `submitted:resource row of ${quiz}`] },
  });

  // What the folder cannot map is an error at its path, and then there is no manifest.
  const first = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
  const refusals: [file: string, change: (text: string) => string, field?: string][] = [
    ['sampling/reading/notes.txt', () => 'A file of no kind the reading folder takes.\n'],
    ['sampling/reading/extra.md', () => '# A reading that no entry lists\n'],
    ['sampling/topic.yaml', (t) => t.replace(`- id: ${first}\n   `, '-'), 'resources[0].id'],
    ['tides/topic.yaml', (t) => t.replace(`id: ${tides}`, `id: ${sampling}`), 'id'],
    ['tides/topic.yaml', (t) => t.replace('position: 0', 'position: 1'), 'position'],
    ['sampling/topic.yaml', (t) => t.replace(`- ${tides}`, `- ${first}`), 'prerequisites[0]'],
    ['sampling/topic.yaml', (t) => t.replace(`- ${tides}`, `- ${sampling}`), 'prerequisites[0]'],
    // What the editor's forms refuse: an address that is no https one, and an empty deck.
    ['sampling/notebooks/tide.shiny.yaml', () => 'url: javascript:alert(1)\n', 'url'],
    ['sampling/slides/transects.md', () => ''],
  ];
  for (const [file, change, field] of refusals) {
    const refused = await read(copy(file, change));
    expect(refused.manifest).toBeNull();
    const named = { severity: 'error', path: file, ...(field && { field }) };
    expect(refused.problems).toContainEqual(expect.objectContaining(named));
  }

  // The changed copy: topics in each other's places, a topic folder and a file renamed, and a
  // file moved with its entry to the other topic. Every id stays, and both references resolve.
  const after = await read(join(fixtures, 'course-changed'));
  expect(after.problems).toEqual([]);
  expect(after.manifest).toEqual(golden('course-changed'));
  const ids = (list = topics) => list.flatMap((t) => [t.id, ...t.resources.map((r) => r.id)]);
  expect(ids(after.manifest?.topics).sort()).toEqual(ids().sort());
  const [moved, other] = after.manifest?.topics ?? [];
  expect([moved?.id, other?.id, moved?.prerequisites]).toEqual([sampling, tides, [tides]]);
  expect(moved?.resources.map((resource) => resource.id)).toContain(quiz);
  expect(moved?.completionRule?.requires).toContain(`submitted:${quiz}`);
});

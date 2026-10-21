import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exerciseV1, testV1 } from '@parallax/contracts';
import { afterAll, expect, test } from 'vitest';
import { readCourseForSync } from './folder/read';

delete process.env.DATABASE_URL;
const definitions = resolve(import.meta.dirname, '../fixtures/definitions');
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-a42-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
const topic = 'id: 0b2f4a6c-8d1e-4f3a-b5c7-9e0a1b2c3d4e\nposition: 0\ntitle: Definitions\n';
const entry = 'id: 3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f, title: One definition';

let courses = 0;
/** A course declared private whose one topic lists one definition of the fixtures, as `tab`. */
async function read(tab: string, from: string) {
  const dir = join(temp, `course-${courses++}`);
  const name = from.split('/').at(-1) ?? from;
  const path = `defs/${tab}/${name}`;
  fs.mkdirSync(join(dir, `defs/${tab}`), { recursive: true });
  fs.writeFileSync(join(dir, 'course.yaml'), 'title: Definitions\npublic: false\n');
  const resources = `resources:\n  - { ${entry}, file: ${tab}/${name} }\n`;
  fs.writeFileSync(join(dir, 'defs/topic.yaml'), `${topic}${resources}`);
  fs.cpSync(join(definitions, from), join(dir, path));
  // A test's code files lie in the folder of its name beside it.
  const beside = join(definitions, from.replace(/\.yaml$/, ''));
  if (fs.existsSync(beside))
    fs.cpSync(beside, join(dir, path.replace(/\.yaml$/, '')), { recursive: true });
  return { path, ...(await readCourseForSync(dir, {})) };
}
/** A field as design §3 names it: `steps[0].answer`. */
const field = (at: PropertyKey[]) =>
  at
    .map((key, i) => (typeof key === 'number' ? `[${key}]` : `${i ? '.' : ''}${String(key)}`))
    .join('');

test('A42 a YAML exercise or test is accepted exactly when the schema accepts the same definition, and a rejected file names the field', async () => {
  const pairs = ['exercises', 'tests'].flatMap((tab) =>
    fs
      .readdirSync(join(definitions, tab))
      .flatMap((name) => (name.endsWith('.yaml') ? [[tab, name]] : [])),
  );
  expect(pairs.length).toBeGreaterThanOrEqual(5);
  for (const [tab = '', name = ''] of pairs) {
    const schema = tab === 'tests' ? testV1 : exerciseV1;
    const json = fs.readFileSync(join(definitions, tab, name.replace(/\.yaml$/, '.json')), 'utf8');
    const twin = schema.safeParse(JSON.parse(json));
    const { path, manifest, problems } = await read(tab, `${tab}/${name}`);
    const source = manifest?.topics[0]?.resources[0]?.source;
    // Accepted exactly when the schema accepts the JSON twin, with the schema's result.
    expect(source && 'definition' in source ? source.definition : null).toEqual(twin.data ?? null);
    // Refused with one problem for each field the schema refuses, each with its line.
    const fields = (twin.error?.issues ?? []).flatMap((issue) =>
      issue.code === 'unrecognized_keys'
        ? issue.keys.map((key) => field([...issue.path, key]))
        : [field(issue.path)],
    );
    expect(problems.map((problem) => [problem.path, problem.field])).toEqual(
      fields.map((f) => [path, f]),
    );
    for (const problem of problems) expect(problem.line).toBeGreaterThan(0);
  }
  // One fixture for each refused YAML feature: the file is named with the line its comment states.
  const refused = fs.readdirSync(join(definitions, 'refused'));
  expect(refused).toHaveLength(5);
  for (const name of refused) {
    const said = /line (\d+)/.exec(fs.readFileSync(join(definitions, 'refused', name), 'utf8'));
    const { path, manifest, problems } = await read('exercises', `refused/${name}`);
    expect(manifest).toBeNull();
    const line = Number(said?.[1]);
    expect(problems).toEqual([
      expect.objectContaining({ severity: 'error', code: 'yaml', path, line }),
    ]);
  }
});

test('A42 an unknown icon in a YAML exercise is named with the nearest icons', async () => {
  const { manifest, problems } = await read('exercises', 'exercises/interactive-problems.yaml');
  expect(manifest).toBeNull();
  expect(problems.filter((problem) => problem.message.includes('is not an icon'))).toEqual([
    expect.objectContaining({
      message: 'is not an icon: try triangle (the icons are listed at lucide.dev/icons)',
      line: expect.any(Number),
    }),
  ]);
});

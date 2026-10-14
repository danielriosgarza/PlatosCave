import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { courseMeta, exerciseV1, testV1 } from '@parallax/contracts';
import { afterAll, expect, test } from 'vitest';
import { checked, loadExercise, loadTest } from './definition';
import { walk } from './listing';
import { type Problem, parseYaml } from './yaml';

delete process.env.DATABASE_URL;
const fixtures = resolve(import.meta.dirname, '../../fixtures/definitions');
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-definition-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
const quiz = 'tests/quiz.yaml';
const main = 'tests/quiz/q3/main.py';
const bytes = (path: string) => fs.readFileSync(join(fixtures, path));
/** A test of a folder, with the files that the listing of its `tests/` gives. */
const load = (root: string, file = quiz) => loadTest(root, file, walk(root, 'tests').files);
/** Each problem as the line design §3 prints, without the line number. */
const lines = (problems: Problem[]) =>
  problems.map(({ path, field, message }) => [path, field, message].filter(Boolean).join(': '));

const unanswered = ['steps[0].answer', 'steps[1].answer', 'steps[1].tolerance'];
test.each<[file: string, fields: string[], lines: number[]]>([
  ['exercises/estimate.yaml', [], []],
  ['exercises/no-answer.yaml', unanswered, [5, 17, 18]],
  [quiz, [], []],
  ['tests/two-answers.yaml', ['questions[0]'], [3]],
])(
  '%s gives the schema’s result for its JSON twin, or names each refused field',
  async (file, fields, at) => {
    const [read, schema] = file.startsWith('tests/')
      ? ([load, testV1] as const)
      : ([loadExercise, exerciseV1] as const);
    const loaded = await read(fixtures, file);
    const twin = schema.safeParse(JSON.parse(bytes(file.replace('.yaml', '.json')).toString()));
    expect(twin.success).toBe(fields.length === 0);
    expect(loaded.definition).toEqual(twin.data);
    const problem = { severity: 'error', code: 'schema', path: file };
    expect(loaded.problems).toMatchObject(
      fields.map((field, i) => ({ ...problem, field, line: at[i] })),
    );
  },
);

test('an unknown key of a strict schema is named as a field, with its line', () => {
  const file = parseYaml('title: Reef ecology\npublic: true\nid: 7\n', 'course.yaml');
  const unknown = { severity: 'error', code: 'schema', path: 'course.yaml', field: 'id', line: 3 };
  expect(checked(file, courseMeta).problems).toEqual([{ ...unknown, message: 'unknown key' }]);
});

test('a code file is filled from the file beside the definition, as text and as base64', async () => {
  type Written = { questions: { files: { path: string; content?: string }[] }[] };
  const written = parseYaml(bytes(quiz).toString(), quiz).value as Written;
  // Two questions use the path main.py, and each gets the file of its own folder.
  const beside: [question: number, file: number, content: string][] = [
    [2, 0, bytes(main).toString()],
    [3, 0, bytes('tests/quiz/q4/main.py').toString()],
    [3, 1, bytes('tests/quiz/q4/data/counts.bin').toString('base64')],
  ];
  expect(beside[0]?.[2]).not.toBe(beside[1]?.[2]);
  for (const [question, file, content] of beside) {
    const entry = written.questions[question]?.files[file];
    expect(entry && 'content' in entry).toBe(false);
    Object.assign(entry ?? {}, { content });
  }
  // Nothing else differs from the parsed value: with the three contents it is the schema's input.
  expect(await load(fixtures)).toEqual({ definition: testV1.parse(written), problems: [] });
});

type Change = { write?: Record<string, string | Buffer>; remove?: string };
let copies = 0;
/** The fixtures in a temporary folder, with one file removed and others written. */
function copy({ write = {}, remove }: Change): string {
  const root = join(temp, `copy-${copies++}`);
  fs.cpSync(fixtures, root, { recursive: true });
  if (remove) fs.rmSync(join(root, remove));
  for (const [path, content] of Object.entries(write)) {
    fs.mkdirSync(join(root, path, '..'), { recursive: true });
    fs.writeFileSync(join(root, path), content);
  }
  return root;
}

const entry = `${quiz}: questions[2].files[0].path`;
const check = 'tests/quiz/q3/tests/check.py';
/** In a question's folder, outside one, and under an id that is no code question's. */
const unused = ['tests/quiz/notes.txt', 'tests/quiz/q1/main.py', 'tests/quiz/q3/old.py'];
test.each<[label: string, change: Change, problems: string[]]>([
  ['a missing file', { remove: main }, [`${entry}: no file ${main}`]],
  [
    'a file with inline content as well',
    { write: { [check]: 'print(2)\n' } },
    [`${quiz}: questions[2].files[1].content: ${check} holds it as well`],
  ],
  [
    'an unused file',
    { write: Object.fromEntries(unused.map((file) => [file, ''])) },
    unused.map((file) => `${file}: no entry names it`),
  ],
  [
    'a file read as text that is not valid UTF-8',
    { write: { [main]: Buffer.from([0x70, 0xff, 0xfe]) } },
    [`${entry}: ${main} is not valid UTF-8`],
  ],
  [
    'a file whose name on disk differs in case',
    { remove: main, write: { 'tests/quiz/q3/Main.py': '' } },
    [`${entry}: no file ${main}`, 'tests/quiz/q3/Main.py: no entry names it'],
  ],
])('%s is named', async (_, change, problems) => {
  const loaded = await load(copy(change));
  expect([loaded.definition, lines(loaded.problems)]).toEqual([undefined, problems]);
});

test.each<[label: string, key: 'path' | 'id', value: (outside: string) => string]>([
  ['a path that climbs out', 'path', () => '../../outside'],
  ['a path with backslashes', 'path', () => '..\\..\\outside'],
  ['an absolute path', 'path', (outside) => JSON.stringify(outside)],
  ['a question id that climbs out', 'id', () => '../outside'],
  ['an absolute question id', 'id', (outside) => JSON.stringify(outside)],
])('%s is refused, and no file outside the test’s folder is opened', async (_, key, value) => {
  // Where each of these would lead lies a folder: opening it as a file would throw.
  const root = copy({ write: { 'tests/outside/main.py/keep': '' } });
  const [written, field] = key === 'path' ? ['path: main.py', 'files[0].path'] : ['id: q3', 'id'];
  const unsafe = `${key}: ${value(join(root, 'tests/outside'))}`;
  fs.writeFileSync(join(root, quiz), bytes(quiz).toString().replace(written, unsafe));
  const loaded = await load(root);
  const refusal = expect.stringContaining(`${quiz}: questions[2].${field}: expected a `);
  // The file of the entry that was changed is then one that no entry names.
  expect(lines(loaded.problems)).toEqual([refusal, `${main}: no entry names it`]);
  expect(loaded.definition).toBeUndefined();
});

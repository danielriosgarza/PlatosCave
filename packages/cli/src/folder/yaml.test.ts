import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { parseYaml } from './yaml';

delete process.env.DATABASE_URL;
const fixtures = resolve(import.meta.dirname, '../../fixtures/definitions');
const read = (path: string) => fs.readFileSync(join(fixtures, path), 'utf8');
const value = (text: string) => parseYaml(text, 'quiz.yaml').value;

test.each<[feature: string, line: number, message: RegExp]>([
  ['duplicate-key', 8, /stands twice/],
  ['cycle', 9, /its own node/],
  ['number-key', 12, /must be a string/],
  ['infinite', 9, /not finite/],
  ['second-document', 10, /second document/],
])('refused/%s.yaml is refused with file and line', (feature, line, message) => {
  const path = `refused/${feature}.yaml`;
  const problem = { severity: 'error', code: 'yaml', path, line };
  expect(parseYaml(read(path), path)).toMatchObject({
    value: undefined,
    problems: [{ ...problem, message: expect.stringMatching(message) }],
  });
});

test('a file that is no YAML, an alias without its anchor and one past the alias limit are refused', () => {
  const lines = (text: string) => parseYaml(text, 'quiz.yaml').problems.map(({ line }) => line);
  expect(lines('questions: [1, 2\nsettings: 3\n')).toEqual([2]);
  expect(lines('questions:\n  - *missing\n')).toEqual([2]);
  // Each list names the one before ten times: written out, the last holds 10 000 items.
  const lists = ['a: &a [1]'];
  for (const [name, before] of ['ba', 'cb', 'dc', 'ed']) {
    lists.push(`${name}: &${name} [${`*${before}, `.repeat(10)}]`);
  }
  const deep = parseYaml(lists.join('\n'), 'quiz.yaml');
  expect(deep).toMatchObject({ value: undefined, problems: [{ severity: 'error', code: 'yaml' }] });
});

test('an anchor with its alias gives the value of the definition written out', () => {
  expect(read('exercises/estimate.yaml')).toContain('feedback: *feedback');
  expect(parseYaml(read('exercises/estimate.yaml'), 'estimate.yaml')).toMatchObject({
    value: JSON.parse(read('exercises/estimate.json')),
    problems: [],
  });
});

// A timestamp and a quoted number stay strings, and a tag outside the core schema is not read.
test.each<[feature: string, text: string, plain: unknown]>([
  ['a timestamp', 'on: 2026-10-14', { on: '2026-10-14' }],
  ['a timestamp with a time', 'at: 2001-12-14t21:59:43Z', { at: '2001-12-14t21:59:43Z' }],
  ['a quoted number', 'count: "12"', { count: '12' }],
  ['a quoted boolean', "open: 'true'", { open: 'true' }],
  ['the tag !!timestamp', 'on: !!timestamp 2001-12-14', { on: '2001-12-14' }],
  ['the tag !!binary', 'bytes: !!binary aGVsbG8=', { bytes: 'aGVsbG8=' }],
  ['the tag !!set', 'both: !!set { a, b }', { both: { a: null, b: null } }],
  ['a tag of another language', 'run: !python/object:os.system "reef"', { run: 'reef' }],
])('%s constructs nothing and leaves the plain value', (_, text, plain) => {
  expect(value(text)).toEqual(plain);
});

test('a file that starts with %YAML 1.1 is read the same: no date, yes a string, << a key', () => {
  const text = '%YAML 1.1\n---\non: 2026-10-14\nopen: yes\nbase: &base { open: no }\n<<: *base\n';
  const read12 = { on: '2026-10-14', open: 'yes', base: { open: 'no' }, '<<': { open: 'no' } };
  expect(value(text)).toEqual(read12);
  expect(value(text.replace('%YAML 1.1\n---\n', ''))).toEqual(read12);
  // What the core schema does read stays read: a number, a boolean and a null.
  const core = { count: 12, open: true, none: null };
  expect(value('%YAML 1.1\n---\ncount: 12\nopen: true\nnone: ~\n')).toEqual(core);
});

test('the line of a field is its key’s, and that of its nearest parent where it is absent', () => {
  const { lineOf } = parseYaml(read('exercises/no-answer.yaml'), 'no-answer.yaml');
  expect(lineOf(['steps', 1, 'tolerance'])).toBe(18);
  expect(lineOf(['steps', 1, 'feedback'])).toBe(19);
  expect(lineOf(['steps', 0, 'answer'])).toBe(5);
  expect(lineOf([])).toBe(3);
});

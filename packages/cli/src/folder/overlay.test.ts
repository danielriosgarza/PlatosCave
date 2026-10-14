import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { type Course, definitionSource } from './overlay';

delete process.env.DATABASE_URL;
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-overlay-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
const estimate = 'sampling/exercises/estimate.yaml';
const quiz = 'sampling/tests/quiz.yaml';
const code = 'sampling/tests/quiz/q3/main.py';
const draft = 'sampling/exercises/_draft.yaml';
const listed = [estimate, quiz];
const absent = 'no definition here';

let sites = 0;
/** A site with one course folder and its folder in the overlay, each holding the files named. */
function site(inTree: string[], inOverlay: string[] = []) {
  const root = join(temp, `site-${sites++}`);
  const course = { tree: join(root, 'courses/reef'), overlay: join(root, 'private/courses/reef') };
  const material = ['course.yaml', 'sampling/topic.yaml', 'sampling/reading/methods.md'];
  for (const file of [...material, ...inTree]) write(join(course.tree, file));
  for (const file of inOverlay) write(join(course.overlay, file));
  return course;
}
function write(file: string): void {
  fs.mkdirSync(join(file, '..'), { recursive: true });
  fs.writeFileSync(file, '');
}
/** What a reading refuses: each path, marked where it is the overlay's, with its message. */
function refused(course: Course, files?: string[]): string[] {
  return definitionSource(course, files).problems.map((problem) => {
    expect(problem).toMatchObject({ severity: 'error', code: 'overlay' });
    return `${problem.overlay ? 'private: ' : ''}${problem.path}: ${problem.message}`;
  });
}

test('a tree declared public reads its definitions from the overlay, a private one from itself', () => {
  // Skipped: a name with a dot, and one with an underscore in a course, topic or tab folder.
  const skipped = ['.gitkeep', '_notes/plan.md', 'sampling/_old/quiz.yaml', draft];
  const open = site(['sampling/exercises/.gitkeep'], [estimate, quiz, code, ...skipped]);
  const files = [estimate, quiz, code];
  const fromOverlay = { root: open.overlay, files, problems: [] };
  expect(definitionSource({ ...open, public: true }, listed)).toEqual(fromOverlay);
  const closed = site([estimate, quiz, code, draft]);
  const fromTree = { root: closed.tree, files, problems: [] };
  expect(definitionSource({ ...closed, public: false }, listed)).toEqual(fromTree);
  expect(definitionSource({ tree: closed.tree, public: false }, listed)).toEqual(fromTree);
});

test('a link that leaves the overlay is refused there; one in a topic folder of the tree is the reader’s', () => {
  const linked = site([], [estimate, quiz]);
  fs.symlinkSync(temp, join(linked.overlay, 'sampling/tests/out'), 'junction');
  fs.symlinkSync(temp, join(linked.tree, 'sampling/out'), 'junction');
  const link = { severity: 'error', code: 'path', path: 'sampling/tests/out', overlay: true };
  const { problems } = definitionSource({ ...linked, public: true }, listed);
  expect(problems).toEqual([expect.objectContaining(link)]);
});

test('a file under exercises/ or tests/ of a public tree is refused, also one that starts with _', () => {
  const leaking = site([estimate, code, draft, 'sampling/tests/.gitkeep'], [quiz]);
  const held = 'a tree declared public holds no exercise or test: it belongs in the overlay';
  const files = [draft, estimate, code].map((path) => `${path}: ${held}`);
  // The exercise is listed: it is refused where it lies, and not missed in the overlay as well.
  expect(refused({ ...leaking, public: true }, listed)).toEqual(files);
  // A reading that opens no definition, a site build's, lists the tree and refuses the same.
  expect(refused({ tree: leaking.tree, public: true })).toEqual(files);
});

test('a definition in both places is refused under either declaration, and both are named', () => {
  const both = site([quiz], [estimate, quiz]);
  expect(refused({ ...both, public: true }, listed)).toEqual([
    `${quiz}: in the tree and in the overlay: a tree declared public keeps it in the overlay`,
  ]);
  expect(refused({ ...both, public: false }, [quiz])).toEqual([
    `private: ${estimate}: the overlay of a tree declared private holds no file`,
    `private: ${quiz}: in the overlay and in the tree: a tree declared private keeps it in the tree`,
  ]);
});

test('a file in the overlay of a private tree is refused', () => {
  const closed = site([estimate, quiz], [code, 'sampling/reading/notes.md', '_notes/plan.md']);
  const none = 'the overlay of a tree declared private holds no file';
  const files = ['_notes/plan.md', 'sampling/reading/notes.md', code];
  expect(refused({ ...closed, public: false }, listed)).toEqual(
    files.map((path) => `private: ${path}: ${none}`),
  );
});

test('a listed definition in neither place is refused with the path it was expected at', () => {
  const none = site([], [estimate]);
  expect(refused({ ...none, public: true }, listed)).toEqual([`private: ${quiz}: ${absent}`]);
  expect(refused({ tree: none.tree, public: false }, [quiz])).toEqual([`${quiz}: ${absent}`]);
  // A checkout of a public repository has no private/ at all.
  const { tree, overlay } = site([]);
  const expected = listed.map((path) => `private: ${path}: ${absent}`);
  expect(refused({ tree, overlay, public: true }, listed)).toEqual(expected);
  expect(refused({ tree, public: true }, listed)).toEqual(expected);
  const nothing = { root: undefined, files: [], problems: [] };
  expect(definitionSource({ tree, public: true })).toEqual(nothing);
});

test('an entry of the overlay outside exercises/ and tests/ is refused', () => {
  const stray = ['loose.yaml', 'sampling/topic.yaml', 'sampling/reading/paper.pdf'];
  const mixed = site([], [estimate, quiz, 'sampling/notebooks/counts/data.csv', ...stray]);
  const outside = 'the overlay holds topic folders with exercises/ and tests/ and nothing else';
  const entries = ['loose.yaml', 'sampling/notebooks', 'sampling/reading', 'sampling/topic.yaml'];
  expect(refused({ ...mixed, public: true }, listed)).toEqual(
    entries.map((path) => `private: ${path}: ${outside}`),
  );
});

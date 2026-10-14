import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { listFolder, screen, walk } from './listing';

delete process.env.DATABASE_URL;
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-listing-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
/** A site: the course folder is the root that is read, and `private/` lies outside it. */
const root = join(temp, 'courses/reef');
const reading = 'sampling/reading';
for (const path of [
  `courses/reef/${reading}/methods.md`,
  `courses/reef/${reading}/.gitkeep`,
  'courses/reef/sampling/_drafts/old.md',
  'courses/reef/sampling/notebooks/counts/data/quadrats.csv',
  'courses/reef/sampling/notebooks/counts/_notes.txt',
  'courses/reef/sampling/notebooks/counts/.ipynb_checkpoints/counts.ipynb',
  'private/courses/reef/sampling/tests/quiz.yaml',
  'elsewhere/paper.pdf',
]) {
  fs.mkdirSync(join(temp, path, '..'), { recursive: true });
  fs.writeFileSync(join(temp, path), '');
}
/** A junction on Windows and a symbolic link elsewhere, from a folder of the root to `target`. */
const link = (target: string, at: string) =>
  fs.symlinkSync(join(temp, target), join(root, at), 'junction');
const file = (name: string) => ({ name, path: `${reading}/${name}`, folder: false });
const refused = (path: string) => expect.objectContaining({ severity: 'error', path });

test('.gitkeep and a folder _drafts are skipped, and beside a notebook only a name with a dot', () => {
  const folder = (name: string) => ({ name, path: `sampling/${name}`, folder: true });
  const topic = { entries: [folder('notebooks'), folder('reading')], problems: [] };
  expect(listFolder(root, 'sampling')).toEqual(topic);
  expect(listFolder(root, reading)).toEqual({ entries: [file('methods.md')], problems: [] });
  const beside = 'sampling/notebooks/counts';
  const files = [`${beside}/_notes.txt`, `${beside}/data/quadrats.csv`];
  expect(walk(root, beside)).toEqual({ files, problems: [] });
});

test('a link that leaves the root or leads into private/ is refused, and one that stays is followed', () => {
  link('elsewhere', `${reading}/outside`);
  link('private/courses/reef/sampling/tests', `${reading}/tests`);
  link('courses/reef/sampling/notebooks/counts/data', `${reading}/data`);
  const data = { name: 'data', path: `${reading}/data`, folder: true };
  const problems = [refused(`${reading}/outside`), refused(`${reading}/tests`)];
  expect(listFolder(root, reading)).toEqual({ entries: [data, file('methods.md')], problems });
  const files = [`${reading}/data/quadrats.csv`, `${reading}/methods.md`];
  expect(walk(root, reading)).toEqual({ files, problems });
  // A link that stays inside and leads back to a folder above it has no end, so it is refused.
  const beside = 'sampling/notebooks/counts';
  link('courses/reef/sampling/notebooks', `${beside}/data/up`);
  expect(walk(root, 'sampling/notebooks')).toEqual({
    files: [`${beside}/_notes.txt`, `${beside}/data/quadrats.csv`],
    problems: [refused(`${beside}/data/up`)],
  });
});

test('a link to a file whose target lies outside the root is refused too', () => {
  // A junction links folders only, so the listing's entry is given with its target.
  const listed = [
    { name: 'paper.pdf', folder: false, target: join(temp, 'elsewhere/paper.pdf') },
    { name: 'methods.md', folder: false, target: join(root, 'sampling/methods.md') },
    { name: 'gone.md', folder: false, target: null },
  ];
  const problems = [refused(`${reading}/gone.md`), refused(`${reading}/paper.pdf`)];
  expect(screen(listed, root, reading)).toEqual({ entries: [file('methods.md')], problems });
});

test('two names that differ only in case are refused with both named', () => {
  // A Windows folder cannot hold both, so the names are given as a list.
  const names = ['paper.pdf', 'methods.md', 'Methods.md', '_Drafts', '_drafts'];
  const { entries, problems } = screen(
    names.map((name) => ({ name, folder: false })),
    root,
    reading,
  );
  expect(entries).toEqual([file('paper.pdf')]);
  expect(problems.map(({ path, message }) => `${path}: ${message}`)).toEqual([
    `${reading}/Methods.md: differs only in case from ${reading}/methods.md`,
    `${reading}/methods.md: differs only in case from ${reading}/Methods.md`,
  ]);
});

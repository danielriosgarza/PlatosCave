import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, test, vi } from 'vitest';
import { readCourseForSite, readCourseForSync } from './folder/read';
import { main } from './main';

delete process.env.DATABASE_URL;
const fixtures = resolve(import.meta.dirname, '../fixtures');
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-a43-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
const course = 'courses/reef-ecology';
const held = 'a tree declared public holds no exercise or test: it belongs in the overlay';

let sites = 0;
/** `parallax check` in a copy of a fixture site, changed by `change`: exit code and lines. */
async function check(fixture: string, change: (site: string) => void = () => {}) {
  const site = join(temp, `site-${sites++}`);
  fs.cpSync(join(fixtures, fixture), site, { recursive: true });
  change(site);
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line));
  try {
    return { code: await main(['check'], { cwd: site }), lines, site };
  } finally {
    log.mockRestore();
  }
}

test('A43 a public tree that holds a test or exercise definition is refused and the file is named', async () => {
  // The exercise, the test and both code files of the test, each named with its path.
  const leaked = [
    'exercises/estimate.yaml',
    'tests/quiz.yaml',
    'tests/quiz/q3/main.py',
    'tests/quiz/q3/tests/check.py',
  ];
  const paths = leaked.map((file) => `sampling/${file}`);
  const leaking = await check('course-leaking');
  expect(leaking.code).toBe(1);
  expect(leaking.lines).toEqual(
    expect.arrayContaining(paths.map((path) => `${course}/${path}: ${held}`)),
  );
  // The reading of a level 0 build gives the same refusal.
  const site = await readCourseForSite(join(leaking.site, course));
  expect(site.manifest).toBeNull();
  expect(
    site.problems.filter((problem) => problem.message === held).map((problem) => problem.path),
  ).toEqual(paths);

  // A definition in both places is refused, and the message says so.
  const both = await check('course', (dir) =>
    fs.cpSync(join(dir, 'private', course, 'sampling/tests'), join(dir, course, 'sampling/tests'), {
      recursive: true,
    }),
  );
  expect(both.code).toBe(1);
  const twice = 'in the tree and in the overlay: a tree declared public keeps it in the overlay';
  expect(both.lines).toContain(`${course}/sampling/tests/quiz.yaml: ${twice}`);

  // The good fixture: what the operator's manifest carries, the site manifest leaves out.
  const good = join(fixtures, 'course');
  const sync = await readCourseForSync(join(good, course), {
    overlay: join(good, 'private', course),
  });
  const open = await readCourseForSite(join(good, course));
  expect(open.problems).toEqual([]);
  const [operator, served] = [JSON.stringify(sync.manifest), JSON.stringify(open.manifest)];
  const hidden = ['7e6d5c4b-3a29-4f18-8e07-6d5c4b3a2918', 'sampling/reading/paper.pdf'];
  const kinds = ['answer', 'hint', 'solution', 'feedback', 'hidden-check', 'hidden-file'];
  for (const planted of [...hidden, ...kinds.map((kind) => `sentinel-${kind}`)]) {
    expect(operator).toContain(planted);
    expect(served).not.toContain(planted);
  }
  expect(() => open.open('sampling/reading/paper.pdf')).toThrow();
});

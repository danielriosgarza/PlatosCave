import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { readCourseForSync } from './folder/read';

delete process.env.DATABASE_URL;
const fixture = resolve(import.meta.dirname, '../fixtures/course');
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-a38-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

/** The fixture's `courses/` and its overlay placed unchanged in a site at `holder`; its course read. */
async function placed(site: string, holder: string) {
  const at = (...parts: string[]) => join(temp, site, ...parts);
  fs.cpSync(join(fixture, 'courses'), at(holder, 'courses'), { recursive: true });
  fs.cpSync(join(fixture, 'private/courses'), at('private', holder, 'courses'), {
    recursive: true,
  });
  const course = join(holder, 'courses/reef-ecology');
  return readCourseForSync(at(course), { overlay: at('private', course) });
}

test('A38 a courses/ folder placed unchanged under instructors/<name>/ yields the same topics and resources', async () => {
  const instructor = await placed('instructor', '.');
  const school = await placed('school', 'instructors/ana');
  expect(instructor.problems).toEqual([]);
  expect(instructor.manifest?.topics.flatMap((topic) => topic.resources)).toHaveLength(9);
  expect(school.problems).toEqual([]);
  expect(school.manifest).toEqual(instructor.manifest);
});

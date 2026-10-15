import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, expectTypeOf, test } from 'vitest';
import type { PageProps } from '../../pages';
import { catalogue } from './folders';
import { loadSite, SiteProblems } from './load';

const fixtures = resolve(import.meta.dirname, '../../fixtures/site');
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-folders-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
delete process.env.DATABASE_URL;

// Ana's course has a course.yaml with a title; Ben's has none and keeps its folder's name.
const reef = { slug: 'reef-ecology', title: 'Reef ecology' };
const statistics = { slug: 'statistics', title: 'statistics' };
const ana = { slug: 'ana', name: 'Ana Example', courses: [reef] };
const ben = { slug: 'ben', name: 'Ben Example', courses: [statistics] };

test('the catalogue lists the instructors in the order of the configuration, with names and titles only', async () => {
  const school = await loadSite(join(fixtures, 'school'));
  // What a page receives, as the types of `parallax-site/pages` declare it.
  expectTypeOf(catalogue(school)).toEqualTypeOf<PageProps['catalogue']>();
  expect(catalogue(school)).toEqual({ instructors: [ana, ben] });
  school.config.instructors.reverse();
  school.instructors.reverse();
  expect(catalogue(school)).toEqual({ instructors: [ben, ana] });
  // The site root, the one instructor folder of instructor mode, has a slug of its own.
  expect(catalogue(await loadSite(join(fixtures, 'instructor')))).toEqual({
    instructors: [{ slug: 'instructor', name: 'Cleo Example', courses: [statistics] }],
  });
});

test('the catalogue reads no title from outside the site: a course folder behind a link keeps its name', async () => {
  const root = join(temp, 'school');
  fs.cpSync(join(fixtures, 'school'), root, { recursive: true });
  const outside = join(temp, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(join(outside, 'course.yaml'), 'title: Title from outside\npublic: true\n');
  fs.symlinkSync(outside, join(root, 'instructors/ben/courses/linked'), 'junction');
  // A link on the way counts as well: Ana's courses/ moved out of the site, a link in its place.
  fs.renameSync(join(root, 'instructors/ana/courses'), join(temp, 'ana-courses'));
  fs.symlinkSync(join(temp, 'ana-courses'), join(root, 'instructors/ana/courses'), 'junction');
  const linked = { slug: 'linked', title: 'linked' };
  expect(catalogue(await loadSite(root))).toEqual({
    instructors: [
      { ...ana, courses: [{ ...reef, title: 'reef-ecology' }] },
      { ...ben, courses: [linked, statistics] },
    ],
  });
});

test('the catalogue is built from what loadSite listed and keeps no address', async () => {
  const site = await loadSite(join(fixtures, 'school'));
  const moved = { ...site, root: join(fixtures, 'no-such-site') };
  moved.instructors[0]?.courses.push('genetics');
  const built = catalogue(moved);
  expect(built.instructors[0]?.courses).toEqual([
    { slug: 'reef-ecology', title: 'reef-ecology' },
    { slug: 'genetics', title: 'genetics' },
  ]);
  expect(JSON.stringify(built)).not.toContain('@');
  // A name the catalogue's schema refuses stops the build, with the field named.
  moved.instructors[0]?.courses.push('bad\u0007name');
  let refused: unknown;
  try {
    catalogue(moved);
  } catch (error) {
    refused = error;
  }
  expect(refused).toBeInstanceOf(SiteProblems);
  expect((refused as SiteProblems).lines[0]).toMatch(/^catalogue: instructors\[0\]\.courses\[2\]/);
});

import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteCatalogue } from '@parallax/contracts';
import { readCourseHeader } from '../folder/read';
import { loadSource } from '../paths';
import { type Site, SiteProblems } from './load';

// The tool reaches the contracts when it runs (paths.ts): once, so that the catalogue is synchronous.
const contracts = await loadSource<typeof import('@parallax/contracts')>(
  'contracts',
  'src/index.ts',
);

/** The slug of the site root, the one instructor folder of instructor mode, whose reference `.` is no folder's name. */
export const ROOT_SLUG = 'instructor';

/** The catalogue's rule for a title, stricter than `course.yaml`'s: no control character. */
const TITLE = contracts.siteCatalogue.shape.instructors.element.shape.courses.element.shape.title;

/**
 * A course's title in the catalogue: the title of its `course.yaml` (`readCourseHeader`), and its
 * folder's name where the file is absent or gives no title the catalogue takes. The title is read
 * only where the course folder really lies at its path in the site, with no link on the way from
 * the site folder, so that no title is read from outside the site: a linked folder keeps its name.
 */
function titleOf(root: string, path: string, name: string): string {
  try {
    const dir = join(root, path, 'courses', name);
    const real = join(realpathSync.native(root), path, 'courses', name);
    const title = realpathSync.native(dir) === real ? readCourseHeader(dir)?.title : undefined;
    return (title !== undefined && TITLE.safeParse(title).data) || name;
  } catch {
    return name;
  }
}

/**
 * The build-time catalogue of a site (docs/design/site.md §6.6): the instructor folders that
 * `loadSite` checked, in the order of the configuration, each with its course folders and their
 * titles. It lists no folder again: the course folders are those `loadSite` listed, and of each it
 * opens `course.yaml` alone. It keeps names and titles only, so the address in `instructor.yaml`
 * stays out. A name or title that the schema refuses stops the build, with its field.
 */
export function catalogue(site: Site): SiteCatalogue {
  const parsed = contracts.siteCatalogue.safeParse({
    instructors: site.instructors.map(({ ref, path, meta, courses }) => ({
      slug: ref === '.' ? ROOT_SLUG : ref,
      name: meta.name,
      courses: courses.map((name) => ({ slug: name, title: titleOf(site.root, path, name) })),
    })),
  });
  if (parsed.success) return parsed.data;
  const lines = contracts.siteIssueLines(parsed.error.issues);
  throw new SiteProblems(lines.map((line) => `catalogue: ${line}`));
}

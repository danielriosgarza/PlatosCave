import { join, posix } from 'node:path';
import type { OpenCourse } from '@parallax/contracts';
import { many, printProblem, shown } from '../commands/check';
import { loadSource } from '../paths';
import { catalogue } from '../site/folders';
import type { Site } from '../site/load';
import { findPages } from '../site/pages';
import { buildCourse } from './course';
import { assertSeparateHosts } from './origins';
import { BuildStop, createOutput, type Output, placeOutput } from './output';
import { LEVEL_0, type ShellCompiler } from './shell';

const contracts = await loadSource<typeof import('@parallax/contracts')>(
  'contracts',
  'src/index.ts',
);
const { courseRef, openCatalogue, openCourse, openPaths, tabs } = contracts;

/** The path below `site/` of the file at an address: the address decoded, without its first `/`. */
const fileOf = (address: string) => address.split('/').map(decodeURIComponent).join('/').slice(1);
/** Prints each line of a message, control characters as escapes: it may name course text. */
const say = (message: string) => {
  for (const line of message.split('\n')) console.error(shown(line));
};
/** A stop, and that `dist/` is as it was; P5-07's level 0 message stands alone, as it did. */
function stopped(message: string): number {
  say(message);
  if (message !== LEVEL_0) console.error('parallax build: dist/ is as it was.');
  return 1;
}

/**
 * `parallax build` at level 0 (docs/design/open-site.md §2, §4): the host rule; every course of
 * every instructor folder through `buildCourse`, its problems printed as `parallax check` prints
 * them; the catalogue; the shell from `shell`; a copy of its `index.html` at every address; the
 * audit; and `dist/site` and `dist/content` put in place. It reads the folder and no database. A
 * build that stops leaves `dist/` as it was. Resolves to the exit code.
 */
export async function buildOpenSite(site: Site, { shell }: { shell: ShellCompiler }) {
  const { root, config } = site;
  const work = join(root, '.parallax/open');
  try {
    // First, with the origins of the loaded configuration: nothing is read or written before.
    assertSeparateHosts(config.origins);
    // A page and the catalogue stop the build before anything is written; `/` is the shell itself.
    const pages = findPages(root).filter((page) => page.path !== '/');
    const listed = catalogue(site);
    const out = await createOutput({ workDir: work, contentOrigin: config.origins.content });
    const addresses = ['/courses', ...pages.map((page) => page.path)];
    let errors = 0;
    for (const { ref: instructor, path, meta, courses } of site.instructors) {
      for (const name of courses) {
        const from = posix.join(path, 'courses', name);
        const ref = courseRef(config.mode, instructor, name);
        // The course's topics, for their addresses, as its `course.json` is written.
        let topics: OpenCourse['topics'] = [];
        const data: Output['data'] = (file, schema, value) => {
          out.data(file, schema, value);
          if (schema === openCourse) ({ topics } = value as OpenCourse);
        };
        const { shiny: shinyOrigins } = config.origins;
        const course = { dir: join(root, from), ref, instructors: [meta.name], shinyOrigins };
        const { problems } = await buildCourse(course, { ...out, data });
        for (const problem of problems) printProblem(from, problem);
        errors += problems.filter((problem) => problem.severity === 'error').length;
        const tabsOf = (topicId: string) => tabs.map((tab) => openPaths.topic(ref, topicId, tab));
        addresses.push(openPaths.course(ref), ...topics.flatMap(({ topicId }) => tabsOf(topicId)));
      }
    }
    if (errors > 0)
      return stopped(`parallax build: ${many(errors, 'error')} above; no site is written.`);
    // Names, titles and course references: the catalogue of the site toolkit, without its slugs.
    const { mode } = config;
    const instructors = listed.instructors.map(({ slug, name, courses }) => ({
      name,
      courses: courses.map(({ slug: course, title }) => ({
        ref: courseRef(mode, slug, course),
        title,
      })),
    }));
    out.data(fileOf(openPaths.catalogue), openCatalogue, { mode, instructors });
    await shell(site, out);
    for (const address of addresses) out.address(fileOf(address));
    out.finish();
  } catch (error) {
    if (error instanceof BuildStop) return stopped(error.message);
    throw error;
  }
  try {
    placeOutput(work, join(root, 'dist'));
  } catch (error) {
    // Before dist/ is emptied, or after: it may hold nothing of this build, or a part of it.
    say(`parallax build: the output was not placed in full: ${(error as Error).message}`);
    console.error('parallax build: dist/ may hold a part of this build; run parallax build again.');
    return 1;
  }
  const { app, content } = config.origins;
  console.error(`parallax build: dist/site is for ${app}, and dist/content for ${content}.`);
  return 0;
}

import { join, posix } from 'node:path';
import { readCourseForSite, readCourseForSync } from '../folder/read';
import type { Command } from '../main';

/** What `check` says at level 0, which reads a course folder as a level 0 build does (§6). */
export const LEVEL_0 =
  'note: at level 0 no exercise or test definition is read, as a level 0 build reads none';
/** A line as it is printed: control, format and separator characters as code points. */
const shown = (line: string) =>
  line.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, (char) => `\\u{${char.codePointAt(0)?.toString(16)}}`);

/**
 * `parallax check` (docs/design/course-folder.md §9): the reader's problems for every course folder
 * of the site, read as the site's level reads it, one line each, with its path from the site
 * folder. It needs no server and writes nothing. Errors exit 1, warnings and notes 0, usage 2.
 */
export const run: Command['run'] = async ({ site, args }) => {
  if (args.length > 0) {
    console.error(shown(`parallax check: unknown argument ${args[0]}; it takes none`));
    return 2;
  }
  const level0 = site.config.level === 0;
  let [courses, errors] = [0, 0];
  for (const { path, courses: names } of site.instructors) {
    for (const name of names) {
      const from = posix.join(path, 'courses', name);
      const overlay = join(site.root, 'private', from);
      const dir = join(site.root, from);
      const read = level0 ? readCourseForSite(dir) : readCourseForSync(dir, { overlay });
      for (const { severity, path: at, overlay: hidden, field, line, message } of (await read)
        .problems) {
        const where = [hidden ? `private/${from}` : from, at].filter(Boolean).join('/');
        const kind = severity === 'error' ? '' : `${severity}: `;
        const lineNumber = line ? ` (line ${line})` : '';
        console.log(shown(`${kind}${where}: ${field ? `${field}: ` : ''}${message}${lineNumber}`));
        if (severity === 'error') errors++;
      }
      courses++;
    }
  }
  if (level0) console.log(LEVEL_0);
  console.log(`parallax check: ${courses} course folders read, ${errors} errors.`);
  return errors > 0 ? 1 : 0;
};

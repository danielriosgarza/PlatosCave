import { join, posix } from 'node:path';
import { applyIds, planIds, topicFolders } from '../folder/ids';
import { type Located, publicationReport, uploadProblems } from '../folder/publication';
import { readCourseForSite, readCourseForSync } from '../folder/read';
import { type Problem, refusal } from '../folder/yaml';
import type { Command } from '../main';

/** What `check` says at level 0, which reads a course folder as a level 0 build does (§6). */
export const LEVEL_0 =
  'note: at level 0 no exercise or test definition is read, as a level 0 build reads none';
/** What `check` leaves out of publication's checks (§9), which only `sync` or a build checks. */
export const LEFT_OUT =
  "note: check leaves out the publication rules of tests, conversions, the course's other drafts, and a server whose settings differ from parallax.config.ts";
/**
 * A line as it is printed: control, format and separator characters as code points, and, in a line
 * not in NFC, every character outside ASCII, so that two Unicode forms of a name read apart.
 */
const shown = (line: string) =>
  line.replace(
    line === line.normalize('NFC') ? /[\p{C}\p{Zl}\p{Zp}]/gu : /[^\x20-\x7e]/gu,
    (char) => `\\u{${char.codePointAt(0)?.toString(16)}}`,
  );
const print = (line: string) => console.log(shown(line));
const many = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * `parallax check [--write-ids]` (docs/design/course-folder.md §9): for each course folder, read as
 * the site's level reads it, the reader's problems, the upload rules and publication's report, one
 * line each. It needs no server, and writes only the missing ids that `--write-ids` asks for
 * (§4.1). Errors exit 1, warnings and notes 0, usage 2.
 */
export const run: Command['run'] = async ({ site, args }) => {
  const writeIds = args[0] === '--write-ids';
  const other = args[writeIds ? 1 : 0];
  if (other !== undefined) {
    console.error(shown(`parallax check: unknown argument ${other}; it takes --write-ids or none`));
    return 2;
  }
  const level0 = site.config.level === 0;
  let [courses, errors] = [0, 0];
  for (const { path, courses: names } of site.instructors) {
    for (const name of names) {
      const from = posix.join(path, 'courses', name);
      const overlay = join(site.root, 'private', from);
      const dir = join(site.root, from);
      const problems: Problem[] = [];
      if (writeIds) {
        const plan = await planIds(dir);
        if (!plan) print(`${from}: no id written while the errors below stand`);
        const { written, changed } = applyIds(dir, plan?.edits ?? []);
        for (const w of written) print(`${from}/${w.path}: ${w.field}: set to ${w.id}`);
        const meanwhile = (at: string) => refusal('id', at, 'changed meanwhile: no id written');
        problems.push(...(plan?.problems ?? []), ...changed.map(meanwhile));
      }
      const read = await (level0 ? readCourseForSite(dir) : readCourseForSync(dir, { overlay }));
      problems.push(...read.problems);
      if (read.manifest) {
        const folders = topicFolders(dir);
        const options = { approvedShinyOrigins: site.config.origins.shiny, folders };
        const { errors: blocking, warnings } = publicationReport(read.manifest, undefined, options);
        const as = (severity: Problem['severity']) => (issue: Located) => ({ ...issue, severity });
        problems.push(...(await uploadProblems(read.manifest, read.open, folders)));
        problems.push(...blocking.map(as('error')), ...warnings.map(as('warning')));
      }
      for (const { severity, path: at, overlay: hidden, field, line, message } of problems) {
        const where = [hidden ? `private/${from}` : from, at].filter(Boolean).join('/');
        const kind = severity === 'error' ? '' : `${severity}: `;
        const lineNumber = line ? ` (line ${line})` : '';
        print(`${kind}${where}: ${field ? `${field}: ` : ''}${message}${lineNumber}`);
        if (severity === 'error') errors++;
      }
      courses++;
    }
  }
  if (level0) console.log(LEVEL_0);
  console.log(LEFT_OUT);
  console.log(`parallax check: ${many(courses, 'course folder')} read, ${many(errors, 'error')}.`);
  return errors > 0 ? 1 : 0;
};

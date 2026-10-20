import { join, posix } from 'node:path';
import { syncBundle } from '../folder/bundle';
import { readCourseForSync } from '../folder/read';
import { noServer, runInServer } from '../host/compose';
import type { Command } from '../main';
import { many, printProblem, shown } from './check';

const FLAGS = new Map<string, 'overwriteEditor' | 'acceptNewIds'>([
  ['--overwrite-editor', 'overwriteEditor'],
  ['--accept-new-ids', 'acceptNewIds'],
]);
const fold = (name: string) => name.normalize('NFC').toLowerCase();
const say = (line: string) => console.error(shown(`parallax sync: ${line}`));

/**
 * `parallax sync [<course> …] [--overwrite-editor] [--accept-new-ids]` (docs/design/course-folder.md
 * §10) at level 1 or 2. A `<course>` is named as in `classes[].course`, exactly as the listing
 * spells it (§4.2); without one, every course. Each is read with its overlay before any run, and
 * an error stops all. Each course, in the site's order, is then one run of the server's script
 * with its bundle on standard input; the exit code is the highest. Usage and level 0 exit 2.
 */
export const run: Command['run'] = async ({ site, args }) => {
  const options = { overwriteEditor: false, acceptNewIds: false };
  const refs: string[] = [];
  for (const arg of args) {
    const flag = FLAGS.get(arg);
    if (flag) options[flag] = true;
    else if (!arg.startsWith('-')) refs.push(arg);
    else {
      say(`unknown option ${arg}; it takes course names, --overwrite-editor and --accept-new-ids`);
      return 2;
    }
  }
  if (site.config.level === 0) {
    noServer('sync');
    return 2;
  }
  const school = site.config.mode === 'school';
  const all = site.instructors.flatMap((folder) =>
    folder.courses.map((name) => ({ folder, name, ref: school ? `${folder.ref}/${name}` : name })),
  );
  const wrong = refs.filter((ref) => !all.some((course) => course.ref === ref));
  for (const ref of wrong) {
    const near = all.find((course) => fold(course.ref) === fold(ref));
    const why = near && `the name on disk is ${near.ref}, not ${ref} (case or Unicode form)`;
    say(`${ref}: ${why ?? 'no course folder of this name in the site'}`);
  }
  if (wrong.length > 0) return 2;

  const reads = [];
  let errors = 0;
  for (const course of all.filter(({ ref }) => refs.length === 0 || refs.includes(ref))) {
    const from = posix.join(course.folder.path, 'courses', course.name);
    const overlay = join(site.root, 'private', from);
    const read = await readCourseForSync(join(site.root, from), { overlay });
    for (const problem of read.problems) {
      printProblem(from, problem);
      if (problem.severity === 'error') errors++;
    }
    if (read.manifest) reads.push({ ...course, from, manifest: read.manifest, open: read.open });
  }
  if (errors > 0) {
    say(`${many(errors, 'error')} in the course folders; no course was synced`);
    return 1;
  }
  let code = 0;
  for (const { folder, name, from, manifest, open } of reads) {
    console.log(shown(`parallax sync: ${from}`));
    const path = posix.join(folder.path, 'instructor.yaml');
    const instructor = { email: folder.meta.email, path };
    const bundle = syncBundle({ instructor, course: name, manifest, options }, open);
    const exit = await runInServer(site, 'src/scripts/sync-course.ts', bundle.stream);
    // A script that stopped early left the rest of the bundle unread; its open file is closed.
    bundle.stream.destroy();
    if (bundle.stopped()) console.error(shown(`${from}/${bundle.stopped()}`));
    if (exit !== 0) say(`${from}: exit code ${exit}; the lines above say why`);
    code = Math.max(code, exit);
  }
  return code;
};

import * as fs from 'node:fs';
import { listFolder, walk } from './listing';
import { type Problem, refusal } from './yaml';

/** A course folder, what its `course.yaml` declares, and the course's own folder in the overlay. */
export type Course = { tree: string; public: boolean; overlay?: string };
/** Where definitions are read from: the folder, and every file under its answer folders. */
export type Source = { root?: string; files: string[]; problems: Problem[] };

const inOverlay = (problem: Problem): Problem => ({ ...problem, overlay: true });
const refuse = (path: string, message: string) => refusal('overlay', path, message);

/**
 * What the topic folders of a tree or of an overlay hold: every file under an `exercises/` or a
 * `tests/` folder, which are the answer-bearing ones (docs/design/course-folder.md §6), and
 * every other entry. `underscore` is whether a name that starts with `_` is skipped in those two
 * folders. `problems` are what the listings refuse: links and names that differ only in case.
 */
function answerFiles(root: string, underscore: boolean) {
  const found = { files: [] as string[], others: [] as string[], problems: [] as Problem[] };
  const list = (folder: string, skip = true) => {
    const { entries, problems } = listFolder(root, folder, skip);
    found.problems.push(...problems);
    return entries;
  };
  for (const topic of list('')) {
    if (!topic.folder) found.others.push(topic.path);
    for (const tab of topic.folder ? list(topic.path) : []) {
      const answers = tab.folder && ['exercises', 'tests'].includes(tab.name);
      if (!answers) found.others.push(tab.path);
      for (const entry of answers ? list(tab.path, underscore) : []) {
        const beside = entry.folder ? walk(root, entry.path) : undefined;
        found.files.push(...(beside?.files ?? [entry.path]));
        found.problems.push(...(beside?.problems ?? []));
      }
    }
  }
  found.files.sort();
  return found;
}

/**
 * Where the definitions of a course are read from (design §6): the overlay for a tree declared
 * public, the tree for one declared private; `root` is absent where a public tree has no overlay.
 * `listed` are the definitions the topics list, by their paths from the course folder. A reading
 * that opens no definition, a site build's, passes none and no overlay: it gets what the tree
 * alone refuses. The listings' refusals are reported for the overlay and for the answer folders
 * of the tree, which this function lists and the reader of the other folders does not.
 */
export function definitionSource(course: Course, listed: string[] = []): Source {
  const overlay = course.overlay && fs.existsSync(course.overlay) ? course.overlay : undefined;
  // Under `exercises/` and `tests/` of a tree declared public only a name with a dot is skipped.
  const tree = answerFiles(course.tree, !course.public);
  const below = tree.problems.filter((problem) => problem.path.split('/').length > 2);
  const absent = (from: string[]) =>
    listed.filter((path) => !from.includes(path)).map((path) => refuse(path, 'no definition here'));
  if (!course.public) {
    const held = overlay ? walk(overlay, '') : { files: [], problems: [] };
    const files = held.files.map((path) => {
      const both = 'in the overlay and in the tree: a tree declared private keeps it in the tree';
      const none = 'the overlay of a tree declared private holds no file';
      return refuse(path, tree.files.includes(path) ? both : none);
    });
    const problems = [...files, ...held.problems].map(inOverlay);
    problems.unshift(...below);
    return { root: course.tree, files: tree.files, problems: [...problems, ...absent(tree.files)] };
  }
  const read = overlay ? answerFiles(overlay, true) : { files: [], others: [], problems: [] };
  const held = tree.files.map((path) => {
    const both = 'in the tree and in the overlay: a tree declared public keeps it in the overlay';
    const none = 'a tree declared public holds no exercise or test: it belongs in the overlay';
    return refuse(path, read.files.includes(path) ? both : none);
  });
  const outside = 'the overlay holds topic folders with exercises/ and tests/ and nothing else';
  const others = read.others.map((path) => refuse(path, outside));
  // A definition that the tree holds is refused above, and is not looked for in the overlay too.
  const missing = absent([...read.files, ...tree.files]);
  const problems = [...others, ...read.problems, ...missing].map(inOverlay);
  return { root: overlay, files: read.files, problems: [...below, ...held, ...problems] };
}

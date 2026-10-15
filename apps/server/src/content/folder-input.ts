import { createHash } from 'node:crypto';
import {
  CourseFileRefused,
  type CourseManifest,
  checkDataPaths,
  courseFileCheck,
  declareWorkspaceFiles,
} from '@parallax/contracts';

/**
 * The upload rules on the server's side, for `parallax sync` (docs/design/course-folder.md §8):
 * each file of a bundle passes them while it streams into storage, with its size and sha256
 * compared with the manifest's, and a notebook with data files is stored naming them. The text
 * that no file carries (a web deck, a definition) is checked by the plan (`folder-plan.ts`).
 */

/** A file of the bundle that is not the one its manifest entry states: the bundle is malformed. */
export class BundleMismatch extends Error {}

/**
 * The bytes of one file of the bundle, passed on while they are checked. The stream ends at the
 * first problem, with the rule's `CourseFileRefused` or a `BundleMismatch` for a short, long or
 * altered file: the refused chunk is not passed on, nothing after it is judged, and the rules'
 * `end` runs only after every byte was accepted. Storage discards an object whose stream fails.
 */
export async function* checkedFile(
  file: CourseManifest['files'][number],
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array, void, undefined> {
  const check = courseFileCheck(file.format);
  const hash = createHash('sha256');
  const mismatch = (what: string) =>
    new BundleMismatch(`${file.path}: ${what} the manifest states`);
  let size = 0;
  for await (const chunk of source) {
    size += chunk.length;
    if (size > file.size) throw mismatch(`the bundle holds more than the ${file.size} bytes`);
    check.push(chunk);
    hash.update(chunk);
    yield chunk;
  }
  if (size < file.size) throw mismatch(`the bundle holds ${size} of the ${file.size} bytes`);
  if (hash.digest('hex') !== file.sha256) throw mismatch('the bytes differ from the sha256');
  check.end();
}

/**
 * The editor's `pathProblem` (`apps/web/src/authoring/workspaceFiles.ts`) for a path that is a
 * `WorkspacePath`, restated with its sentences; the test holds the two equal.
 */
function pathProblem(path: string, others: readonly string[]): string | undefined {
  if (path.trim() === '') return 'Enter a path';
  if (path !== path.trim()) return 'The path starts or ends with a space';
  if (others.includes(path)) return 'Another file already has this path';
  if (others.some((o) => o.startsWith(`${path}/`) || path.startsWith(`${o}/`))) {
    return 'A file cannot also be a folder of another file';
  }
  return undefined;
}

/**
 * The notebook stored for one with data files: `declareWorkspaceFiles` given each data file's
 * workspace path and object id and nothing more, as the editor gives them (a row that carries a
 * size would put it into the notebook). Paths are held to the editor's rules as well, and the
 * first path the editor would refuse is named with its sentence.
 */
export function notebookWithData(
  text: string,
  data: readonly { path: string; resourceId: string }[],
): string {
  const paths = data.map(({ path }) => path);
  checkDataPaths(paths);
  for (const [i, path] of paths.entries()) {
    const problem = pathProblem(
      path,
      paths.filter((_, j) => j !== i),
    );
    if (problem !== undefined) throw new CourseFileRefused(`${path}: ${problem}`);
  }
  return declareWorkspaceFiles(
    text,
    data.map(({ path, resourceId }) => ({ path, resourceId })),
  );
}

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isMap, isNode, isSeq, parseDocument } from 'yaml';
import { listFolder } from './listing';
import { readCourseForSite } from './read';
import { type Problem, parseYaml, refusal } from './yaml';

/** An id that `check --write-ids` set: its `topic.yaml`, from the course folder, its field, the id. */
export type Written = { path: string; field: string; id: string };
/** One `topic.yaml` to replace: its bytes as they were read, and its text with the ids written in. */
export type IdEdit = { path: string; read: Buffer; text: string; set: Written[] };
/** The files to replace, and a problem for each file that would not read back with its ids. */
export type IdPlan = { edits: IdEdit[]; problems: Problem[] };
type Entry = { id?: string; resources?: Entry[] };

const UNREAD = 'no id written: with them it would not read the same';
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The `topic.yaml` of each topic folder, as the reader reads it: its bytes, text and document. */
function topicFiles(dir: string) {
  return listFolder(dir)
    .entries.filter((entry) => entry.folder)
    .map(({ path: folder }) => {
      const path = `${folder}/topic.yaml`;
      const read = fs.readFileSync(join(dir, path));
      const text = utf8.decode(read);
      const doc = parseDocument(text, { schema: 'core', resolveKnownTags: false });
      return { folder, path, read, text, doc };
    });
}

/** Each topic's folder by its folder id, for the paths of a report on a course the reader passed. */
export function topicFolders(dir: string): Map<string, string> {
  return new Map(topicFiles(dir).map(({ folder, doc }) => [String(doc.get('id')), folder]));
}

/**
 * The ids `check --write-ids` writes (docs/design/course-folder.md §4.1): a random UUID as the
 * first key of each topic and entry without one, and no other byte. Null while the folder, read as
 * the site entry reads it, has another error. A file is replaced only if its text reads back, as
 * the reader reads it, as its value with the ids.
 */
export async function planIds(dir: string): Promise<IdPlan | null> {
  const errors = (await readCourseForSite(dir)).problems.filter((p) => p.severity === 'error');
  if (errors.some((p) => p.code !== 'id')) return null;
  const plan: IdPlan = { edits: [], problems: [] };
  const filled = new Set<string>();
  for (const { path, read, text, doc } of errors.length > 0 ? topicFiles(dir) : []) {
    const eol = /\r\n?|\n/.exec(text)?.[0] ?? '\n';
    const resources = doc.get('resources', true);
    const items = (isSeq(resources) ? resources.items : []).map((item, i) => [i, item] as const);
    const want = parseYaml(text, path).value as Entry;
    const set: Written[] = [];
    let edited = text;
    // From the last map to the topic's, whose first key stands first, so that offsets hold.
    for (const [i, map] of [[-1, doc.contents] as const, ...items].reverse()) {
      const key = isMap(map) && !map.has('id') ? map.items[0]?.key : undefined;
      const end = isNode(key) ? key.range?.[0] : undefined;
      if (!isMap(map) || end === undefined) continue;
      // What stands before the key on its line, without a byte-order mark; its anchor or tag too.
      const start = Math.max(text.lastIndexOf('\n', end - 1), text.lastIndexOf('\r', end - 1)) + 1;
      const mark = start === 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
      const before = text.slice(start + mark, end);
      const props = /(?:[&!]\S*[ \t]+)*$/.exec(before)?.[0].length ?? 0;
      const id = randomUUID();
      // On a line of its own, indented as the key it now stands before; in a flow map, in line.
      const line = map.flow ? `id: ${id}, ` : `id: ${id}${eol}${' '.repeat(before.length - props)}`;
      edited = `${edited.slice(0, end - props)}${line}${edited.slice(end - props)}`;
      const field = i < 0 ? 'id' : `resources[${i}].id`;
      const entry = i < 0 ? want : want.resources?.[i];
      if (entry) entry.id = id;
      set.unshift({ path, field, id });
      filled.add(`${path}:${field}`);
    }
    const back = parseYaml(edited, path);
    if (back.problems.length > 0 || !isDeepStrictEqual(back.value, want)) {
      plan.problems.push(refusal('id', path, UNREAD));
    } else if (set.length > 0) plan.edits.push({ path, read, text: edited, set });
  }
  // An id that stands twice is an error of the same code, and no place without an id explains it.
  return errors.every((p) => filled.has(`${p.path}:${p.field}`)) ? plan : null;
}

/**
 * Replaces each file of the plan atomically, by a rename from beside it, after a check that its
 * bytes are still those the plan read. A file that changed meanwhile is left as it is.
 */
export function applyIds(dir: string, edits: IdEdit[]) {
  const done = { written: [] as Written[], changed: [] as string[] };
  for (const { path, read, text, set } of edits) {
    const file = join(dir, path);
    // A name with a dot, which the reader skips should it be left behind.
    const temp = join(dirname(file), `.topic.yaml.${randomUUID()}`);
    fs.writeFileSync(temp, text);
    if (fs.readFileSync(file).equals(read)) {
      fs.renameSync(temp, file);
      done.written.push(...set);
    } else {
      fs.rmSync(temp);
      done.changed.push(path);
    }
  }
  return done;
}

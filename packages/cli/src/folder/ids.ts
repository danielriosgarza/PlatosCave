import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { isMap, isNode, isSeq, parseDocument } from 'yaml';
import { listFolder } from './listing';
import { readCourseForSite } from './read';

/** An id that `check --write-ids` set: its `topic.yaml`, from the course folder, its field, the id. */
export type Written = { path: string; field: string; id: string };
/** One `topic.yaml` to replace: its bytes as they were read, and its text with the ids written in. */
export type IdEdit = { path: string; read: Buffer; text: string; set: Written[] };

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
 * the site entry reads it, has another error: a renamed file's entry then gets no new id.
 */
export async function planIds(dir: string): Promise<IdEdit[] | null> {
  const errors = (await readCourseForSite(dir)).problems.filter((p) => p.severity === 'error');
  if (errors.some((p) => p.code !== 'id')) return null;
  if (errors.length === 0) return [];
  const edits: IdEdit[] = [];
  for (const { path, read, text, doc } of topicFiles(dir)) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const resources = doc.get('resources', true);
    const items = (isSeq(resources) ? resources.items : []).map((item, i) => [i, item] as const);
    const set: Written[] = [];
    let edited = text;
    // From the last map to the topic's, whose first key stands before all of theirs: an offset
    // holds while the text before it is unchanged.
    for (const [i, map] of [...items, [-1, doc.contents] as const].reverse()) {
      const key = isMap(map) && !map.has('id') ? map.items[0]?.key : undefined;
      const at = isNode(key) ? key.range?.[0] : undefined;
      if (!isMap(map) || at === undefined) continue;
      const id = randomUUID();
      // On a line of its own, indented as the key it now stands before; in a flow map, in line.
      const indent = ' '.repeat(at - text.lastIndexOf('\n', at - 1) - 1);
      const line = map.flow ? `id: ${id}, ` : `id: ${id}${eol}${indent}`;
      edited = `${edited.slice(0, at)}${line}${edited.slice(at)}`;
      set.unshift({ path, field: i < 0 ? 'id' : `resources[${i}].id`, id });
    }
    if (set.length > 0) edits.push({ path, read, text: edited, set });
  }
  // An id that stands twice is an error of the same code, and no place without an id explains it.
  const filled = new Set(edits.flatMap(({ set }) => set.map((w) => `${w.path}:${w.field}`)));
  return errors.every((p) => filled.has(`${p.path}:${p.field}`)) ? edits : null;
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

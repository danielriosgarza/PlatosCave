import { createHash } from 'node:crypto';

/**
 * Row ids of a course folder by derivation, with nothing stored to map them
 * (docs/design/course-folder.md §4.3). No database import: the plan of `sync` and its tests use it.
 */

/** The namespace of a course's id. */
export const FOLDER_NAMESPACE = '0b6a98fa-33c2-51ab-9808-310d3f212845';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The version 5 UUID of RFC 9562: SHA-1 over the namespace's bytes and the UTF-8 of `name`. */
export function uuid5(namespace: string, name: string): string {
  if (!UUID.test(namespace)) throw new Error(`${namespace} is no UUID in lower case`);
  const hash = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);
  hash.writeUInt8(((hash[6] ?? 0) & 0x0f) | 0x50, 6);
  hash.writeUInt8(((hash[8] ?? 0) & 0x3f) | 0x80, 8);
  return hash.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-');
}

/** `courses.id`: the owner's account and the course folder's name as the listing spells it. */
export const folderCourseId = (ownerId: string, folderName: string): string =>
  uuid5(FOLDER_NAMESPACE, `${ownerId}/${folderName}`);

/** `topics.id` or `resources.id` of a folder id, inside the course's id. */
export const folderRowId = (courseId: string, kind: 'topic' | 'resource', folderId: string) =>
  uuid5(courseId, `${kind}:${folderId}`);

/** A row a folder made: its id is a version 5 UUID, where the editor's rows have random ones. */
export const isFolderRow = (id: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-5/.test(id);

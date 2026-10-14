import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { folderCourseId, folderRowId, isFolderRow, uuid5 } from './folder-ids';

// Row ids follow from the owner, the course folder's name and the folder ids, with nothing stored
// (docs/design/course-folder.md §4.3). The ids below are the ones §4.3 names.

const owner = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const course = 'cdd107dd-d688-5d66-bfaf-2c8faa8f0434';
const topic = '5f0c1d8e-3b7a-4c2e-9a41-7d2f6b0e1c33';

describe('folder ids', () => {
  test('uuid5 gives the version 5 vector of RFC 9562 and the ids the design names', () => {
    const dns = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    expect(uuid5(dns, 'www.example.com')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
    expect(folderCourseId(owner, 'reef-ecology')).toBe(course);
    expect(folderRowId(course, 'topic', topic)).toBe('889e96fe-a12c-5a3f-b3f8-c7d0b6776086');
    expect(folderRowId(course, 'resource', 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f')).toBe(
      '724bf106-f625-58f0-81a3-dedf684e762c',
    );
  });

  test('the same owner and folder name give the same ids, another owner or name others', () => {
    expect(folderCourseId(owner, 'reef-ecology')).toBe(course);
    const others = [
      folderCourseId(randomUUID(), 'reef-ecology'),
      folderCourseId(owner, 'reef-ecology-2'),
      folderCourseId(owner, 'Reef-ecology'),
    ];
    expect(new Set([course, ...others]).size).toBe(4);
    const rows = others.map((id) => folderRowId(id, 'topic', topic));
    expect(new Set([folderRowId(course, 'topic', topic), ...rows]).size).toBe(4);
    expect(folderRowId(course, 'resource', topic)).not.toBe(folderRowId(course, 'topic', topic));
  });

  test('a row is a folder row exactly when its id is a version 5 UUID', () => {
    expect(isFolderRow(course)).toBe(true);
    expect(isFolderRow(folderRowId(course, 'resource', topic))).toBe(true);
    expect(isFolderRow(randomUUID())).toBe(false);
    expect(isFolderRow(topic)).toBe(false);
  });
});

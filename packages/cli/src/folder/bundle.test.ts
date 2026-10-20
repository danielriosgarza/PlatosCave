import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import type { CourseManifest, SyncHeader } from '@parallax/contracts';
import { expect, test } from 'vitest';
import { loadSource } from '../paths';
import { BUNDLE_FORMAT, syncBundle } from './bundle';
import { readCourseForSync } from './read';

delete process.env.DATABASE_URL;
type File = CourseManifest['files'][number];
type Chunks = AsyncIterable<Uint8Array>;
type Server = {
  readBundle(input: Chunks): Promise<{ header: SyncHeader; files(file: File): Chunks }>;
  checkedFile(file: File, source: Chunks): Chunks;
};
// The script's side, loaded as the tool loads a source: no file here imports one of the server.
const load = (name: string) => loadSource<Server>('server', `src/content/${name}.ts`);
const [server, { checkedFile }] = await Promise.all([load('folder-bundle'), load('folder-input')]);
const fixtures = resolve(import.meta.dirname, '../../fixtures');
const dir = join(fixtures, 'course/courses/reef-ecology');
const overlay = join(fixtures, 'course/private/courses/reef-ecology');
const read = await readCourseForSync(dir, { overlay });
const header: SyncHeader = {
  instructor: { email: 'ana.lima@example.org', path: 'instructor.yaml' },
  course: 'reef-ecology',
  manifest: read.manifest as CourseManifest,
  options: { overwriteEditor: false, acceptNewIds: true },
};
const { files } = header.manifest;
const onDisk = (file: File) => fs.readFileSync(join(dir, file.path));

/** Each file the script's reader gives, through `checkedFile` as `syncCourse` takes it. */
async function readBack(stream: Chunks) {
  const bundle = await server.readBundle(stream);
  const bytes: Buffer[] = [];
  try {
    for (const file of bundle.header.manifest.files) {
      bytes.push(await buffer(checkedFile(file, bundle.files(file))));
    }
  } catch (error) {
    return { refused: (error as Error).message };
  }
  return { header: bundle.header, bytes };
}
/** A bundle written by hand, the file at `at` (from the end if negative) as `change` gives it. */
function byHand(at: number, change: (bytes: Buffer) => Buffer) {
  const bytes: Buffer[] = files.map(onDisk);
  bytes.splice(at, 1, change(bytes.at(at) as Buffer));
  const line = `${JSON.stringify({ format: BUNDLE_FORMAT, ...header })}\n`;
  return Readable.from([Buffer.from(line), ...bytes]);
}

test('the bundle of the fixture course, read back by the script’s reader, gives the golden manifest and every file’s bytes', async () => {
  const golden = fs.readFileSync(join(fixtures, 'course.manifest.json'), 'utf8');
  const bundle = syncBundle(header, read.open);
  expect(await readBack(bundle.stream)).toEqual({
    header: { ...header, manifest: JSON.parse(golden) },
    bytes: files.map(onDisk),
  });
  expect(bundle.stopped()).toBeUndefined();
});

test('a short, long or altered file is refused, and the refusal names the file', async () => {
  const [first, second, last] = [files[0], files[1], files.at(-1)] as [File, File, File];
  const at = (file: File, what: string) => `${file.path}: the ${what} the manifest states`;
  const holds = (n: number, file: File) => at(file, `bundle holds ${n} of the ${file.size} bytes`);
  const differ = 'bytes differ from the sha256';
  const cases: [string, number, (bytes: Buffer) => Buffer][] = [
    // The stream has no frames: a short file takes bytes of the next one, which its sha256 shows.
    [at(first, differ), 0, (b) => b.subarray(1)],
    [at(second, differ), 1, (b) => b.reverse()],
    [holds(last.size - 1, last), -1, (b) => b.subarray(0, -1)],
    // The last file is given one byte more than its size, so that a byte after it names it.
    [at(last, `bundle holds more than the ${last.size} bytes`), -1, (b) => Buffer.concat([b, b])],
  ];
  for (const [refused, index, change] of cases) {
    expect(await readBack(byHand(index, change))).toEqual({ refused });
  }
  // The command sends a file that grew since it was read as it was read, and ends the bundle at
  // one that shrank, so that the script names it.
  const resized = (size: number) => (path: string) =>
    path === first.path
      ? Readable.from([Buffer.concat([onDisk(first), Buffer.from('more')]).subarray(0, size)])
      : read.open(path);
  const grown = await readBack(syncBundle(header, resized(first.size + 4)).stream);
  expect(grown).toMatchObject({ bytes: files.map(onDisk) });
  const shrunk = syncBundle(header, resized(first.size - 2));
  expect(await readBack(shrunk.stream)).toEqual({ refused: holds(first.size - 2, first) });
  expect(shrunk.stopped()).toBe(`${first.path}: shorter than when it was read`);
});

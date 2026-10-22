import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { OpenResource, OpenTopic, SiteManifest, StoredNotebook } from '@parallax/contracts';
import { type Conversion, publicationReport, uploadProblems } from '../folder/publication';
import { readCourseForSite } from '../folder/read';
import { type Problem, refusal } from '../folder/yaml';
import { loadSource } from '../paths';
import { notebookDownload } from './download';
import type { Output } from './output';
import { zip } from './zip';

type Contracts = typeof import('@parallax/contracts');
type UrlFor = (key: string) => string | null;
type Made = { key: string; contentType: string; bytes: Uint8Array };
type Converted = { derived: Record<string, unknown>; objects: Made[] };
type Io = { read(key: string, maxBytes: number): Promise<Uint8Array>; prefix: string };
type Server = {
  convertRevision(source: object, io: Io): Promise<Converted>;
  IngestError: new (message: string) => Error;
  megabytes(bytes: number): string;
  resolveReadingImages(html: string, urlFor: UrlFor): string;
};
// The tool reaches the contracts and the server's conversion and image step when it runs (paths.ts).
const contracts = await loadSource<Contracts>('contracts', 'src/index.ts');
const server = await loadSource<Server>('server', 'src/content/convert.ts');
const { resolveReadingImages } = await loadSource<Server>('server', 'src/content/reading.ts');
type Authoring = typeof import('@parallax/contracts/routes/authoring');
const { MAX_UPLOAD_BYTES } = await loadSource<Authoring>('contracts', 'src/routes/authoring.ts');
const { openCourse, openNotebookFile, openPaths, openResource, openTopic, tabs } = contracts;
type Sourced = Extract<SiteManifest['topics'][number]['resources'][number], { source: unknown }>;
/** What conversion derives, as far as the data files take it. */
type Derived = { slides: string[]; html: string; pageCount: number; notebook: StoredNotebook };

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const utf8 = (text: string) => new TextEncoder().encode(text);
/** An error's own sentence, without its name: the route's message, as the job records it. */
const said = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** A schema's first issue, and the field it is at. */
const issueOf = ({ issues: [issue] }: { issues: { message: string; path: PropertyKey[] }[] }) =>
  `${issue?.message} (${issue?.path.map(String).join('.')})`;

/** What keeps a resource's data file from being written; `code` is its problem's. */
class Unwritable extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Names = string[];
/** `ref` is built from listed folder names (the writer refuses `..`); `instructors` are names. */
export type CourseBuild = { dir: string; ref: string; instructors: Names; shinyOrigins: Names };

/**
 * One course folder of a level 0 build (docs/design/open-site.md §4, §5): read only through the
 * reader's site entry, checked by the upload rules, converted only by `convertRevision`, judged by
 * publication's report, and written through `out` unless a problem is an error. It takes no
 * overlay, runs no notebook cell and selects no resource: the manifest holds the shown ones. It
 * writes neither a notebook's data files, which it checks, nor its `.ipynb`, which it converts.
 */
export async function buildCourse(course: CourseBuild, out: Output) {
  const { dir, ref, instructors, shinyOrigins } = course;
  const { manifest, open, folders, ...read } = await readCourseForSite(dir);
  const problems: Problem[] = [...read.problems];
  const failed = () => problems.some((problem) => problem.severity === 'error');
  if (!manifest || failed()) return { problems };
  problems.push(...(await uploadProblems(manifest, open, folders)));
  if (failed()) return { problems };

  const { keys, bytes, io } = conversionIo(manifest.files, open);

  // Each resource with a source is converted but a Shiny app, which has nothing to convert.
  const derived: Record<string, Conversion> = {};
  const converted = new Map<string, Converted>();
  // A notebook's data files, read for the zip offered beside it (§4, owner's answer to §12 Q1).
  const dataFiles = new Map<string, { path: string; bytes: Uint8Array }[]>();
  const entries = manifest.topics.flatMap((topic) => topic.resources);
  const keyOf = (file: string) => ({ key: keys.get(file) ?? '' });
  for (const entry of entries) {
    if (!('source' in entry) || entry.type === 'shiny') continue;
    if (entry.type === 'notebook' && entry.source.data.length > 0) {
      try {
        const read = entry.source.data.map(async ({ path, file }) => {
          const bytes = await io.read(keys.get(file) ?? '', MAX_UPLOAD_BYTES);
          return { path, bytes };
        });
        dataFiles.set(entry.id, await Promise.all(read));
      } catch (error) {
        problems.push(refusal('data', entry.path, said(error)));
        continue;
      }
    }
    // A notebook without its data files (§4): they have no object id and are not converted.
    const data = entry.type === 'notebook' && { source: { ...entry.source, data: [] } };
    const payload = contracts.revisionPayload({ ...entry, ...data } as Sourced, keyOf);
    try {
      const done = await server.convertRevision(payload, io);
      converted.set(entry.id, done);
      derived[entry.id] = { state: 'ready', derived: done.derived };
    } catch (error) {
      derived[entry.id] = { state: 'failed' };
      problems.push({ ...refusal('conversion', entry.path, said(error)), severity: 'note' });
    }
  }
  const options = { approvedShinyOrigins: shinyOrigins, folders };
  const { errors, warnings } = publicationReport(manifest, derived, options);
  // A topic that lists an exercise or a test is not empty (§4); one with no shown resource is.
  const held = manifest.topics.filter((t) => t.resources.some((r) => !('source' in r)));
  const kept = (issue: { code: string; topicId?: string }) =>
    issue.code !== 'empty_topic' || !held.some((topic) => topic.id === issue.topicId);
  problems.push(...errors.map((issue) => ({ ...issue, severity: 'error' as const })));
  problems.push(...warnings.filter(kept).map((w) => ({ ...w, severity: 'warning' as const })));
  if (failed()) return { problems };

  /** Writes an object and gives its address; the check gives an address and writes nothing. */
  type Put = (bytes: Uint8Array, contentType: string) => string;
  const pdf = (file: string, { pageCount }: Derived, put: Put) => {
    const read = bytes.get(keys.get(file) ?? '');
    if (!read) throw new Unwritable('data', 'The PDF was not read for conversion');
    return { url: put(read, 'application/pdf'), pageCount };
  };
  // What `derived` holds is checked with each value it gives, in the check below.
  const dataOf = ({ type, title, source, id }: Sourced, put: Put): OpenResource => {
    if ('url' in source) {
      const origin = new URL(source.url).origin;
      const framed = shinyOrigins.includes(origin) ? origin : null;
      return { type: 'shiny', title, url: source.url, origin: framed };
    }
    const { derived: d, objects } = converted.get(id) as Converted & { derived: Derived };
    const slides = { type: 'slides', title, pdf: null, web: null } as const;
    if ('markdown' in source) return { ...slides, web: { slides: d.slides } };
    if (type === 'slides_pdf') return { ...slides, pdf: pdf(source.file, d, put) };
    const reading = { type: 'reading', title, kind: 'pdf', html: null, pdf: null } as const;
    if (type === 'reading_pdf') return { ...reading, pdf: pdf(source.file, d, put) };
    if (type === 'reading_native') {
      return { ...reading, kind: 'native', html: resolveReadingImages(d.html, () => null) };
    }
    // Every image, SVG and HTML output, and the file for download, is an object (§2).
    const addresses = new Map(objects.map((o) => [o.key, put(o.bytes, o.contentType)]));
    const urlFor = (key: string) => addresses.get(key) ?? null;
    // One rendered view: the data file's notebook, and what the file for download is made from.
    const notebook = contracts.viewNotebook(d.notebook, urlFor, resolveReadingImages);
    // A cell id the renderer lengthened past 64 characters is no nbformat id (review of PR #599).
    const download = openNotebookFile.safeParse(notebookDownload(notebook));
    const why = 'The notebook file for download cannot be composed';
    if (download.error) throw new Unwritable('notebook', `${why}: ${issueOf(download.error)}`);
    const ipynb = utf8(JSON.stringify(download.data));
    const file = put(ipynb, 'application/x-ipynb+json');
    // One folder named as the notebook: the notebook file and its data files at their paths.
    const files = dataFiles.get(id);
    const name = source.file.split('/').pop() ?? 'notebook.ipynb';
    const folder = name.replace(/\.ipynb$/, '');
    const entries = [{ path: name, bytes: ipynb }, ...(files ?? [])];
    const bundle = entries.map((entry) => ({ ...entry, path: `${folder}/${entry.path}` }));
    const data = files ? put(zip(bundle), 'application/zip') : null;
    return { type: 'notebook', title, file, data, notebook };
  };

  // Every data file of a resource is built and checked before anything is written, with objects
  // that are not written: one that would not pass is refused, by its path, and nothing is written.
  const sourced = entries.filter((entry): entry is Sourced => 'source' in entry);
  const unwritten: Put = (_, contentType) => {
    if (contracts.objectExtension(contentType)) return 'https://content.invalid/o/unwritten';
    throw new Unwritable('data', `An object of type ${contentType} cannot be written`);
  };
  for (const entry of sourced) {
    try {
      const data = openResource.safeParse(dataOf(entry, unwritten));
      const why = 'The data file cannot be written';
      if (data.error) throw new Unwritable('data', `${why}: ${issueOf(data.error)}`);
    } catch (error) {
      const code = error instanceof Unwritable ? error.code : 'data';
      problems.push(refusal(code, entry.path, said(error)));
    }
  }
  if (failed()) return { problems };

  // No file under site/ may have the bytes of a course file the build opened, a deck's text too.
  for (const { path, sha256: digest } of manifest.files) out.untrusted(digest, join(dir, path));
  for (const { path, source } of entries.filter((entry) => entry.type === 'slides_web'))
    out.untrusted(sha256(utf8(source.markdown)), join(dir, path));
  const put: Put = (bytes, contentType) => out.object(bytes, contentType);

  /** Writes a data file at the path its address decodes to, without the first slash. */
  const write = (address: string, schema: { parse(value: unknown): unknown }, value: unknown) =>
    out.data(address.split('/').map(decodeURIComponent).join('/').slice(1), schema, value);
  const topics = manifest.topics.map((topic, index) => {
    const lists: OpenTopic = { slides: [], reading: [], exercises: [], notebooks: [], tests: [] };
    for (const entry of topic.resources) {
      const { id: resourceId, title, type } = entry;
      // An exercise or a test is its entry in a list and nothing more: no file is written for it.
      const tab = ('path' in entry ? entry.path.split('/')[1] : `${type}s`) as keyof OpenTopic;
      const kind = type === 'reading_pdf' ? 'pdf' : 'native';
      const more = tab === 'reading' ? { kind } : tab === 'notebooks' ? { type } : {};
      (lists[tab] as object[]).push({ resourceId, title, ...more });
      if (!('source' in entry)) continue;
      write(openPaths.resourceData(ref, topic.id, resourceId), openResource, dataOf(entry, put));
    }
    write(openPaths.topicData(ref, topic.id), openTopic, lists);
    const presence = Object.fromEntries(tabs.map((tab) => [tab, lists[tab].length > 0]));
    const { id: topicId, objective = '', estimatedMinutes = null } = topic;
    const firstTab = tabs.find((tab) => presence[tab]) ?? null;
    const item = { topicId, number: index + 1, title: topic.title, objective, estimatedMinutes };
    return { ...item, presence, firstTab };
  });
  write(openPaths.courseData(ref), openCourse, { title: manifest.title, instructors, topics });
  return { problems };
}

/**
 * Conversion's storage read of one course folder (docs/design/open-site.md §4). A file's key is
 * `objectKey` under the prefix `open`, by the digest the reader read, and `io.read` answers from
 * the reader's `open` with the size limit a storage read has. It refuses a key that no listed file
 * has, and bytes whose digest is not the key's. `bytes` keeps each file read, by its key: a
 * conversion may take the buffer it is given.
 */
export function conversionIo(
  files: readonly { path: string; sha256: string }[],
  open: (file: string) => Readable,
) {
  const keys = new Map(files.map((file) => [file.path, `open/objects/${file.sha256}`]));
  const paths = new Map([...keys].map(([path, key]) => [key, path]));
  const bytes = new Map<string, Uint8Array>();
  const io: Io = {
    prefix: 'open',
    async read(key, maxBytes) {
      const path = paths.get(key);
      if (path === undefined) throw new server.IngestError('No file of the course has this key');
      const chunks: Buffer[] = [];
      const over = `The file is larger than ${server.megabytes(maxBytes)}`;
      for await (const chunk of open(path)) {
        chunks.push(chunk);
        const size = chunks.reduce((sum, { length }) => sum + length, 0);
        if (size > maxBytes) throw new server.IngestError(over);
      }
      // A buffer of its own, whole and unshared, which a PDF's parsing thread may take.
      const whole = new Uint8Array(Buffer.concat(chunks));
      if (`open/objects/${sha256(whole)}` !== key) throw new server.IngestError('The file changed');
      bytes.set(key, whole);
      return whole.slice();
    },
  };
  return { keys, bytes, io };
}

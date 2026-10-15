import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { OpenResource, OpenTopic, SiteManifest, StoredNotebook } from '@parallax/contracts';
import { topicFolders } from '../folder/ids';
import { type Conversion, publicationReport, uploadProblems } from '../folder/publication';
import { readCourseForSite } from '../folder/read';
import { type Problem, refusal } from '../folder/yaml';
import { loadSource } from '../paths';
import { notebookDownload } from './download';
import type { Output } from './output';

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
const { openCourse, openNotebookFile, openPaths, openResource, openTopic, tabs } = contracts;
type Sourced = Extract<SiteManifest['topics'][number]['resources'][number], { source: unknown }>;
/** What conversion derives, as far as the data files take it. */
type Derived = { slides: string[]; html: string; pageCount: number; notebook: StoredNotebook };

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const utf8 = (text: string) => new TextEncoder().encode(text);

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
  const { manifest, open, ...read } = await readCourseForSite(dir);
  const problems: Problem[] = [...read.problems];
  const failed = () => problems.some((problem) => problem.severity === 'error');
  if (!manifest || failed()) return { problems };
  const folders = topicFolders(dir);
  problems.push(...(await uploadProblems(manifest, open, folders)));
  if (failed()) return { problems };

  // A file's key is `objectKey` under the prefix `open`, by the digest the reader read.
  const keys = new Map(manifest.files.map((file) => [file.path, `open/objects/${file.sha256}`]));
  const paths = new Map([...keys].map(([path, key]) => [key, path]));
  /** Each file read for conversion, by its key: a conversion may take the buffer it is given. */
  const bytes = new Map<string, Uint8Array>();
  const io: Io = {
    prefix: 'open',
    async read(key, maxBytes) {
      const chunks: Buffer[] = [];
      const over = `The file is larger than ${server.megabytes(maxBytes)}`;
      for await (const chunk of open(paths.get(key) ?? '')) {
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

  // Each resource with a source is converted but a Shiny app, which has nothing to convert.
  const derived: Record<string, Conversion> = {};
  const converted = new Map<string, Converted>();
  const entries = manifest.topics.flatMap((topic) => topic.resources);
  const keyOf = (file: string) => ({ key: keys.get(file) ?? '' });
  for (const entry of entries) {
    if (!('source' in entry) || entry.type === 'shiny') continue;
    // A notebook without its data files (§4): they have no object id and are not converted.
    const data = entry.type === 'notebook' && { source: { ...entry.source, data: [] } };
    const payload = contracts.revisionPayload({ ...entry, ...data } as Sourced, keyOf);
    try {
      const done = await server.convertRevision(payload, io);
      converted.set(entry.id, done);
      derived[entry.id] = { state: 'ready', derived: done.derived };
    } catch (error) {
      derived[entry.id] = { state: 'failed' };
      problems.push({ ...refusal('conversion', entry.path, `${error}`), severity: 'note' });
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

  // No file under site/ may have the bytes of a course file the build opened, a deck's text too.
  for (const { path, sha256: digest } of manifest.files) out.untrusted(digest, join(dir, path));
  for (const { path, source } of entries.filter((entry) => entry.type === 'slides_web'))
    out.untrusted(sha256(utf8(source.markdown)), join(dir, path));
  const pdf = (file: string, { pageCount }: Derived) => {
    const read = bytes.get(keys.get(file) ?? '');
    return read ? { url: out.object(read, 'application/pdf'), pageCount } : null;
  };
  const dataOf = ({ type, title, source, id }: Sourced): OpenResource => {
    if ('url' in source) {
      const origin = new URL(source.url).origin;
      const framed = shinyOrigins.includes(origin) ? origin : null;
      return { type: 'shiny', title, url: source.url, origin: framed };
    }
    const { derived: d, objects } = converted.get(id) as Converted & { derived: Derived };
    const slides = { type: 'slides', title, pdf: null, web: null } as const;
    if ('markdown' in source) return { ...slides, web: { slides: d.slides } };
    if (type === 'slides_pdf') return { ...slides, pdf: pdf(source.file, d) };
    const reading = { type: 'reading', title, kind: 'pdf', html: null, pdf: null } as const;
    if (type === 'reading_pdf') return { ...reading, pdf: pdf(source.file, d) };
    if (type === 'reading_native') {
      return { ...reading, kind: 'native', html: resolveReadingImages(d.html, () => null) };
    }
    // Every image, SVG and HTML output, and the file for download, is an object (§2).
    const addresses = new Map(objects.map((o) => [o.key, out.object(o.bytes, o.contentType)]));
    const urlFor = (key: string) => addresses.get(key) ?? null;
    // One rendered view: the data file's notebook, and what the file for download is made from.
    const notebook = contracts.viewNotebook(d.notebook, urlFor, resolveReadingImages);
    const composed = utf8(JSON.stringify(openNotebookFile.parse(notebookDownload(notebook))));
    const file = out.object(composed, 'application/x-ipynb+json');
    return { type: 'notebook', title, file, notebook };
  };

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
      write(openPaths.resourceData(ref, topic.id, resourceId), openResource, dataOf(entry));
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

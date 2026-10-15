import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import type { CourseManifest, SiteManifest } from '@parallax/contracts';
import { loadSource } from '../paths';
import { checked, loadExercise, loadTest, parse, problemAt } from './definition';
import { type Entry, listFolder, sameButCase, walk } from './listing';
import { definitionSource, type Source } from './overlay';
import { type Field, type Problem, parseYaml, refusal } from './yaml';

export type { Problem };

type Contracts = typeof import('@parallax/contracts');
// The tool reaches the contracts when it runs (paths.ts): once, so that the header is synchronous.
const contracts = await loadSource<Contracts>('contracts', 'src/index.ts');
const { courseMeta, topicMeta, resourceKindOf, shinyFile, shinyAddressProblem } = contracts;
type Resource = CourseManifest['topics'][number]['resources'][number];
type Stored = CourseManifest['files'][number];
type Built = { resource: Resource; files: Stored[] };
/** `folders`: each topic's folder by its folder id; empty while `manifest` is null. */
type Read<M> = {
  manifest: M | null;
  problems: Problem[];
  folders: Map<string, string>;
  open(file: string): Readable;
};

/** The tab folders the reader lists itself, and what each takes; exercises/ and tests/ are §6's. */
const TAKES: Record<string, string> = {
  slides: '.md, .markdown, .pdf',
  reading: '.md, .markdown, .html, .pdf',
  notebooks: '.ipynb, .shiny.yaml',
};
const TABS = ['slides', 'reading', 'notebooks', 'exercises', 'tests'];
const IN_COURSE = 'a course folder holds course.yaml and topic folders';
const IN_TOPIC = 'topic folders hold topic.yaml, slides/, reading/, notebooks/, exercises/, tests/';
const NO_FOLDER = 'a folder of a tab folder is the folder of a notebook or a test there, no other';
const UNLISTED = 'no entry of topic.yaml lists it';
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const has = (entries: Entry[], name: string) => entries.some((e) => !e.folder && e.name === name);
const answer = (file: string) => /^(exercise|test)$/.test(resourceKindOf(file) ?? '');
type Mark = (problem: Problem, error?: unknown) => Problem;
const keep: Mark = (problem) => problem;
const inOverlay = (problem: Problem): Problem => ({ ...problem, overlay: true });
const cannot = (error: unknown) =>
  `cannot be read (${(error as NodeJS.ErrnoException).code ?? error})`;
type Attempt = <T>(path: string, run: () => T | Promise<T>, mark?: Mark) => Promise<T | undefined>;
type Loaded = { definition?: unknown; problems: Problem[] };
type Load = (root: string, path: string, type: unknown, files: string[]) => Promise<Loaded>;
/**
 * Where a reading takes definitions from (design §6), given what `course.yaml` declares and the
 * definitions the topics list: the answer files found with the problems of where they lie, `mark`
 * for a problem of a definition, and `load` for one entry's. A reading without `load` opens none.
 */
type Definitions = (
  declared: boolean | undefined,
  listed: string[],
  attempt: Attempt,
  problems: Problem[],
) => Promise<{ source?: Source; mark: Mark; fromOverlay: boolean; load?: Load }>;

/** A listing that `definitionSource` could not make: the problem at its folder, tree or overlay. */
const failedAt =
  (tree: string, overlay?: string, mark = keep): Mark =>
  (problem, error) => {
    const failed = (error as NodeJS.ErrnoException | undefined)?.path;
    const under = (root?: string) => {
      const from = root && failed ? relative(root, failed) : '..';
      const out = from === '..' || from.startsWith(`..${sep}`) || isAbsolute(from);
      return out ? undefined : from.split(sep).join('/');
    };
    const [inTree, held] = [under(tree), under(overlay)];
    if (inTree !== undefined) return { ...problem, path: inTree };
    return held === undefined ? mark(problem) : inOverlay({ ...problem, path: held });
  };
const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** The fields of a parsed definition that the schema's value does not hold: keys it dropped. */
const dropped = (input: unknown, output: unknown, at: Field = []): Field[] => {
  if (Array.isArray(input) && Array.isArray(output)) {
    return input.flatMap((item, i) => dropped(item, output[i], [...at, i]));
  }
  if (!isMap(input) || !isMap(output)) return [];
  return Object.entries(input).flatMap(([key, item]) =>
    Object.hasOwn(output, key) ? dropped(item, output[key], [...at, key]) : [[...at, key]],
  );
};

/**
 * Reads one course folder (docs/design/course-folder.md §2 to §7): its topics in `position` order,
 * or its problems. A file-system error is a problem too, and so is any other throw: it rejects for
 * none. Paths are from the course folder, with `/`; a problem of the overlay is marked `overlay`.
 */
async function readCourse(dir: string, definitions: Definitions) {
  const problems: Problem[] = [];
  const read = await readTree(dir, definitions, problems).catch((error: unknown) => {
    problems.push(refusal('read', '', cannot(error)));
  });
  // One cause is named once: a folder whose listing failed for two readers is one problem.
  const once = new Map(problems.map((problem) => [JSON.stringify(problem), problem]));
  return { course: read?.course, problems: [...once.values()] };
}

async function readTree(dir: string, definitions: Definitions, problems: Problem[]) {
  const refuse = (path: string, message: string, code = 'layout') =>
    problems.push(refusal(code, path, message));
  const attempt: Attempt = async (path, run, mark = keep) => {
    try {
      return await run();
    } catch (error) {
      problems.push(mark(refusal('read', path, cannot(error)), error));
    }
  };
  // A folder whose listing failed: nothing further is said of what it would have held.
  const unread = new Set<string>();
  const listed = async (path: string) => {
    const listing = await attempt(path, () => listFolder(dir, path));
    if (!listing) unread.add(path);
    problems.push(...(listing?.problems ?? []));
    return listing?.entries ?? [];
  };
  /** A YAML file of the tree, by a path a listing gave, with its value as `schema` gives it. */
  const yaml = async <T>(path: string, schema: Parameters<typeof checked<T>>[1]) => {
    const parsed = await attempt(path, () => parse(dir, path));
    const { value, problems: refused } = parsed ? checked(parsed, schema) : { problems: [] };
    problems.push(...refused);
    return parsed && value !== undefined ? { parsed, value } : undefined;
  };
  const stored = async (path: string, format: Stored['format']): Promise<Stored[]> => {
    const bytes = await attempt(path, () => fs.readFileSync(join(dir, path)));
    const sha256 = bytes && createHash('sha256').update(bytes).digest('hex');
    return bytes && sha256 ? [{ path, sha256, size: bytes.length, format }] : [];
  };

  // The course folder itself: a folder and not a link, and the one spelling of its name.
  const name = basename(dir);
  const twin = await attempt('', () =>
    fs.readdirSync(dirname(dir)).find((n) => sameButCase(n, name)),
  );
  const stat = !twin && (await attempt('', () => fs.lstatSync(dir)));
  if (twin) refuse('', `differs only in case from ${twin}, the name on disk`);
  else if (stat && !stat.isDirectory()) refuse('', 'a course folder is a folder, and not a link');
  if (problems.length > 0) return { problems };
  const top = await listed('');
  if (unread.has('')) return { problems };
  let complete = problems.length === 0;
  for (const e of top) if (!e.folder && e.name !== 'course.yaml') refuse(e.path, IN_COURSE);
  const course = has(top, 'course.yaml')
    ? await yaml('course.yaml', courseMeta)
    : void refuse('course.yaml', 'not found: it states the title and public');

  // Each topic folder, and the files in its tab folders but exercises/ and tests/.
  const topics = [];
  for (const folder of top.filter((e) => e.folder)) {
    const entries = await listed(folder.path);
    for (const e of entries)
      if (e.folder ? !TABS.includes(e.name) : e.name !== 'topic.yaml') refuse(e.path, IN_TOPIC);
    const why = 'no topic.yaml: each folder of a course folder is a topic folder';
    const topic = has(entries, 'topic.yaml')
      ? await yaml(`${folder.path}/topic.yaml`, topicMeta)
      : void (unread.has(folder.path) || refuse(folder.path, why));
    const disk = new Map<string, Entry>();
    for (const tab of entries.filter((e) => e.folder && Object.hasOwn(TAKES, e.name))) {
      const files = await listed(tab.path);
      for (const e of files) {
        const ipynb = (f: Entry) => f.name.slice(0, -6) === e.name && /\.ipynb$/i.test(f.name);
        const notebook = tab.name === 'notebooks' && files.some((f) => !f.folder && ipynb(f));
        if (e.folder ? notebook : resourceKindOf(`${tab.name}/${e.name}`)) {
          disk.set(`${tab.name}/${e.name}`, e);
        } else refuse(e.path, e.folder ? NO_FOLDER : `${tab.name}/ takes ${TAKES[tab.name]}`);
      }
    }
    if (topic) topics.push({ folder: folder.path, ...topic, disk });
    // Of a topic whose topic.yaml is refused, the definitions are not said to be unlisted.
    else unread.add(folder.path);
    complete &&= topic !== undefined;
  }

  // Definitions and the files beside a test, from where `public` says (design §6).
  const answers = topics.flatMap(({ folder, value }) =>
    value.resources.flatMap(({ file }) => (answer(file) ? [`${folder}/${file}`] : [])),
  );
  const declared = course?.value.public;
  const found = await definitions(declared, answers, attempt, problems);
  const { source, mark, fromOverlay, load } = found;
  problems.push(...(source?.problems ?? []));
  for (const file of source?.files ?? []) {
    const [topic, tab, name, ...deeper] = file.split('/');
    // A file in the folder of a listed test is that test's to account for (`loadTest`).
    const own = answers.some((a) => a.replace(/\.yaml$/i, '') === `${topic}/tests/${name}`);
    if (answers.includes(file) || (deeper.length > 0 && tab === 'tests' && own)) continue;
    const why =
      deeper.length > 0 ? NO_FOLDER : answer(`${tab}/${name}`) ? UNLISTED : `${tab}/ takes .yaml`;
    // Where a topic's folder or topic.yaml could not be read, nothing its entries decide is said.
    const decided = why === UNLISTED || (deeper.length > 0 && tab === 'tests');
    if (!(decided && unread.has(topic ?? ''))) problems.push(mark(refusal('layout', file, why)));
  }

  // Ids, positions and prerequisites across the course; each entry becomes a resource.
  const ids = new Map<string, string>();
  const positions = new Map<number, string>();
  const topicIds = topics.map(({ value }) => value.id);
  const built = [];
  for (const { folder, parsed, value: meta, disk } of topics) {
    const at = (field: PropertyKey[], message: string, code = 'topic') =>
      problems.push(problemAt(parsed, field, message, code));
    const identify = (id: string | undefined, field: PropertyKey[]) => {
      if (!id) return at(field, 'no id: run parallax check --write-ids to give it one', 'id');
      if (ids.has(id)) return at(field, `this id stands at ${ids.get(id)} too`, 'id');
      ids.set(id, `${parsed.path} (${problemAt(parsed, field, '').field})`);
    };
    identify(meta.id, ['id']);
    const first = positions.get(meta.position);
    if (first) at(['position'], `${first} states this position too`);
    else positions.set(meta.position, parsed.path);
    meta.prerequisites?.forEach((id, i) => {
      if (id === meta.id) at(['prerequisites', i], 'a topic is not its own prerequisite');
      // While a topic folder or a topic.yaml is refused, the ids of the course are not all known.
      else if (complete && !topicIds.includes(id)) at(['prerequisites', i], 'no topic has this id');
    });
    const resources: Built[] = [];
    const used = new Set<string>();
    for (const [i, entry] of meta.resources.entries()) {
      identify(entry.id, ['resources', i, 'id']);
      const { id = '', file, title, visibility, alternative } = entry;
      const path = `${folder}/${file}`;
      const type = resourceKindOf(file);
      const fields = { id, title, visibility, path, type, overlay: answer(file) && fromOverlay };
      const add = (source: unknown, files: Stored[] = []) => {
        const resource = { ...fields, ...(alternative && { alternative }), source } as Resource;
        resources.push({ resource, files });
      };
      if (answer(file)) {
        const root = source?.root;
        // A reading that loads no definition takes the entry as it stands in topic.yaml.
        if (!load) add(undefined);
        else if (root && source.files.includes(path)) {
          const loaded = await attempt(path, () => load(root, path, type, source.files), mark);
          problems.push(...(loaded?.problems ?? []).map((problem) => mark(problem)));
          add({ definition: loaded?.definition });
        }
        continue;
      }
      // Looked up among the names the listing gave, never joined to a path: the disk's spelling.
      const spelled = [...disk.keys()].find((other) => sameButCase(other, file));
      used.add(spelled ?? file);
      if (!disk.has(file)) {
        const why = spelled ? `differs only in case from ${spelled}, the name on disk` : '';
        // Of a tab folder whose listing failed, that problem is the one said.
        const tab = `${folder}/${file.split('/')[0]}`;
        if (!unread.has(tab)) at(['resources', i, 'file'], why || `no file ${path}`, 'layout');
      } else if (type === 'slides_web') {
        const bytes = await attempt(path, () => fs.readFileSync(join(dir, path)));
        try {
          // A deck's text is stored, not its file: the rules of an uploaded Markdown file hold.
          if (bytes && contracts.checkCourseFile('markdown', bytes)) {
            add({ markdown: utf8.decode(bytes) });
          }
        } catch (error) {
          refuse(path, (error as Error).message, 'file');
        }
      } else if (type === 'shiny') {
        const read = await yaml(path, shinyFile);
        const why = read && shinyAddressProblem(read.value.url);
        if (read && why) problems.push(problemAt(read.parsed, ['url'], why, 'shiny'));
        else if (read) add({ url: read.value.url });
      } else if (type === 'notebook') {
        // Its data files lie in the folder of its name, at their workspace paths, sorted.
        const named = path.length - '.ipynb'.length;
        const beside = disk.get(file.slice(0, -'.ipynb'.length));
        const walked = beside && (await attempt(beside.path, () => walk(dir, beside.path)));
        problems.push(...(walked?.problems ?? []));
        const data = (walked?.files ?? []).map((f) => ({ path: f.slice(named + 1), file: f }));
        const files = await Promise.all(data.map((d) => stored(d.file, 'data')));
        add({ file: path, data }, [...files.flat(), ...(await stored(path, 'notebook'))]);
      } else add({ file: path }, await stored(path, contracts.uploadFormatOf(file)));
    }
    for (const [key, e] of disk) if (!used.has(key) && !e.folder) refuse(e.path, UNLISTED);
    built.push({ folder, meta, resources });
  }
  if (!course || problems.some((p) => p.severity === 'error')) return { problems };
  built.sort((a, b) => a.meta.position - b.meta.position);
  return { course: { meta: course.value, topics: built }, problems };
}

/**
 * For `sync` and `check` at level 1 and above: each definition from the overlay or the tree, as
 * `public` says, and a note for each key its schema drops, which is not stored (design §5).
 */
const fromSource =
  (dir: string, overlay: string | undefined): Definitions =>
  async (declared, listed, attempt, problems) => {
    // The course's folder in the overlay, checked here: `definitionSource` would throw for a file.
    const lstat = () => (overlay ? fs.lstatSync(overlay, { throwIfNoEntry: false }) : undefined);
    const held = await attempt('', lstat, inOverlay);
    if (held && !held.isDirectory()) {
      const why = 'not a folder: the overlay of a course is a folder, and not a link';
      problems.push(inOverlay(refusal('overlay', '', why)));
    }
    const into = held?.isDirectory() ? overlay : undefined;
    const mark = declared ? inOverlay : keep;
    const look = () => definitionSource({ tree: dir, public: !!declared, overlay: into }, listed);
    const where = failedAt(dir, into, mark);
    const source = declared === undefined ? undefined : await attempt('', look, where);
    const load: Load = async (root, path, type, files) => {
      const loaded = await (type === 'test'
        ? loadTest(root, path, files)
        : loadExercise(root, path));
      if (loaded.definition === undefined) return loaded;
      const input = parse(root, path);
      const note = (field: Field): Problem => {
        const why = 'no field of its schema, so it is not stored';
        return { ...problemAt(input, field, why, 'dropped'), severity: 'note' };
      };
      return { ...loaded, problems: dropped(input.value, loaded.definition).map(note) };
    };
    return { source, mark, fromOverlay: !!declared, load };
  };

/**
 * A level 0 build's reading (design §7): no overlay, and no definition opened. Of a tree declared
 * public it lists the answer folders to refuse what lies there; of one declared private it finds
 * the definitions the topics list. An exercise or a test is taken as topic.yaml states it.
 */
const listedOnly =
  (dir: string): Definitions =>
  async (declared, listed, attempt) => {
    const look = () => definitionSource({ tree: dir, public: !!declared }, declared ? [] : listed);
    const source = declared === undefined ? undefined : await attempt('', look, failedAt(dir));
    return { source, mark: keep, fromOverlay: false };
  };

/** A manifest as its schema gives it, or a problem; `open(file)` opens only a file it lists. */
function manifestOf<M extends { files: Stored[] }>(
  dir: string,
  { course, problems }: Awaited<ReturnType<typeof readCourse>>,
  read: { data?: M; error?: unknown } | undefined,
): Read<M> {
  if (read?.error) problems.push(refusal('manifest', '', `not a valid manifest: ${read.error}`));
  const manifest = read?.data ?? null;
  const open = (file: string) => {
    if (!manifest?.files.some((s) => s.path === file)) throw new Error(`${file} is not listed`);
    return fs.createReadStream(join(dir, file));
  };
  // A course the reader passed has an id for each topic (`no id` is an error).
  const passed = (manifest && course?.topics) || [];
  const folders = new Map(passed.map((t): [string, string] => [t.meta.id ?? '', t.folder]));
  return { manifest, problems, folders, open };
}

/**
 * The course and its overlay, for `sync` and for `check` at level 1 and above (design §7).
 * `open(file)` opens only a file the manifest lists, from the course folder.
 */
export async function readCourseForSync(
  dir: string,
  { overlay }: { overlay?: string },
): Promise<Read<CourseManifest>> {
  // Resolved: with a trailing separator `lstat` would follow a link to the folder (design §7).
  const tree = resolve(dir);
  const read = await readCourse(tree, fromSource(tree, overlay && resolve(overlay)));
  const { course } = read;
  const topics = course?.topics.map(({ meta, resources }) => {
    return { ...meta, resources: resources.map((r) => r.resource) };
  });
  const files = course?.topics.flatMap((topic) => topic.resources.flatMap((r) => r.files));
  const value = { ...course?.meta, topics, files };
  return manifestOf(tree, read, course && contracts.courseManifest.safeParse(value));
}

/**
 * The course as a level 0 build receives it (design §7): no definition read, no hidden resource
 * and no completion rule. `siteManifest` is strict, so a field outside its allow-list is refused.
 */
export async function readCourseForSite(dir: string): Promise<Read<SiteManifest>> {
  const tree = resolve(dir);
  const read = await readCourse(tree, listedOnly(tree));
  const { course } = read;
  const shown = (list: Built[]) => list.filter((r) => r.resource.visibility === 'visible');
  const topics = course?.topics.map(({ meta: { completionRule: _, ...topic }, resources }) => ({
    ...topic,
    resources: shown(resources).map(({ resource: { overlay: _, ...resource } }) => {
      const { id, title, visibility, type } = resource;
      return type === 'exercise' || type === 'test' ? { id, title, visibility, type } : resource;
    }),
  }));
  const files = course?.topics.flatMap((topic) => shown(topic.resources).flatMap((r) => r.files));
  const value = { title: course?.meta.title, topics, files };
  return manifestOf(tree, read, course && contracts.siteManifest.safeParse(value));
}

/**
 * The title of `course.yaml` for the catalogue (design §7, §11), and nothing where the listing has
 * no `course.yaml` or its title is not valid. It reports no problem and opens no other file.
 */
export function readCourseHeader(dir: string): { title: string } | undefined {
  try {
    if (!has(listFolder(dir).entries, 'course.yaml')) return undefined;
    const text = utf8.decode(fs.readFileSync(join(dir, 'course.yaml')));
    const { value, problems } = parseYaml(text, 'course.yaml');
    const title = courseMeta.shape.title.safeParse((value as { title?: unknown } | null)?.title);
    return problems.length === 0 && title.success ? { title: title.data } : undefined;
  } catch {
    return undefined;
  }
}

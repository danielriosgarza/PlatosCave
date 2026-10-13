import { z } from 'zod';
import { exerciseV1 } from './exercise';
import type { ResourceType, Tab } from './resources';
import { testV1 } from './test';

/**
 * A course folder (docs/design/course-folder.md): its two metadata files (§3), the layout table
 * (§2), the manifests its reader hands on (§7), the header of a sync bundle and what a revision
 * and a topic are stored with (§10). The web application imports the index, so no Node built-in.
 */

/** A folder id (§4.1): a UUID in lower case, written by `parallax check --write-ids`. */
export const folderId = z.uuid().lowercase('expected a UUID in lower case');
const title = z.string().trim().min(1).max(300);
const visibility = z.enum(['visible', 'hidden'], { error: 'expected "visible" or "hidden"' });

/** The layout table (§2): the tab folder, the endings of a file's name, the type it becomes. */
const layout: readonly (readonly [Tab, readonly string[], ResourceType])[] = [
  ['slides', ['.md', '.markdown'], 'slides_web'],
  ['slides', ['.pdf'], 'slides_pdf'],
  ['reading', ['.md', '.markdown', '.html'], 'reading_native'],
  ['reading', ['.pdf'], 'reading_pdf'],
  ['notebooks', ['.ipynb'], 'notebook'],
  ['notebooks', ['.shiny.yaml'], 'shiny'],
  ['exercises', ['.yaml'], 'exercise'],
  ['tests', ['.yaml'], 'test'],
];

/**
 * The type a file becomes, for its path from the topic folder, `<tab folder>/<file name>`; the
 * ending is compared in lower case. Undefined for any other path and for a name the reader
 * skips, which starts with `.` or `_`.
 */
export function resourceKindOf(path: string): ResourceType | undefined {
  const [tab, name, ...deeper] = path.split('/');
  if (!name || deeper.length > 0 || /^[._]/.test(name)) return undefined;
  const ends = (ending: string) => name.toLowerCase().endsWith(ending);
  return layout.find(([folder, endings]) => folder === tab && endings.some(ends))?.[2];
}

/** `course.yaml` (§3). `public` has no default: it says where definitions are read from (§6). */
export const courseMeta = z.strictObject({
  title: z.string().trim().min(1).max(160),
  public: z.boolean(),
});
export type CourseMeta = z.output<typeof courseMeta>;

/** `reviewed:*`, `submitted:*` or `submitted:<folder id of a resource>`; group 1 is that id. */
const REQUIREMENT =
  /^(?:reviewed:\*|submitted:(?:\*|([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})))$/;
const NO_REQUIREMENT =
  'expected reviewed:*, submitted:* or submitted:<id of a resource of this file>';
const requires = z.array(z.string().regex(REQUIREMENT, NO_REQUIREMENT));
const completionRule = z.strictObject({ requires }).optional();

/** A topic's own fields, as `topic.yaml` states them and as both manifests carry them. */
const topicFields = {
  id: folderId,
  position: z.int().min(0),
  title,
  objective: z.string().max(2000).optional(),
  estimatedMinutes: z.int().min(0).max(10_000).optional(),
  prerequisites: z.array(folderId).max(50).optional(),
};
/** A resource's fields in every form. The alternative's bound is the folder's own. */
const entryFields = {
  id: folderId,
  title,
  alternative: z.string().trim().min(1).max(20_000).optional(),
};
const NO_FILE = 'expected <tab folder>/<file name>, a file of the layout table';

/**
 * `topic.yaml` (§3). An `id` may be absent: the reader reports it with the command to run, and
 * `check --write-ids` writes it (§4.1). An id that stands twice and a prerequisite that is no
 * topic are the reader's to find, across the course.
 */
export const topicMeta = z
  .strictObject({
    ...topicFields,
    id: folderId.optional(),
    completionRule,
    resources: z
      .array(
        z.strictObject({
          ...entryFields,
          id: folderId.optional(),
          file: z.string().refine((path) => resourceKindOf(path) !== undefined, NO_FILE),
          visibility: visibility.default('visible'),
        }),
      )
      .max(200),
  })
  .superRefine((topic, ctx) => {
    const refuse = (message: string, ...path: (string | number)[]) =>
      ctx.addIssue({ code: 'custom', path, message });
    const files = new Set<string>();
    topic.resources.forEach(({ file }, i) => {
      if (files.has(file)) refuse(`${file} is listed twice`, 'resources', i, 'file');
      files.add(file);
    });
    const ids = new Set(topic.resources.map((entry) => entry.id));
    topic.completionRule?.requires.forEach((requirement, i) => {
      const id = REQUIREMENT.exec(requirement)?.[1];
      if (id !== undefined && !ids.has(id)) refuse(NO_REQUIREMENT, 'completionRule', 'requires', i);
    });
  });
export type TopicMeta = z.output<typeof topicMeta>;

/** A `*.shiny.yaml` file (§2): `url` and nothing else. */
export const shinyFile = z.strictObject({ url: z.string().trim() });
const fileSource = z.strictObject({ file: z.string() });
/** A notebook's data files, sorted by `path` (the workspace path); `file` is the path in the tree. */
const data = z.array(z.strictObject({ path: z.string(), file: z.string() }));

const entry = <T extends ResourceType, S extends z.ZodType, X extends z.ZodRawShape>(
  types: T[],
  source: S,
  more: X,
) => z.strictObject({ ...entryFields, ...more, type: z.literal(types), path: z.string(), source });
/** The entries whose source is a file, a text or an address; `more` is what one manifest adds. */
const withSource = <X extends z.ZodRawShape>(more: X) =>
  [
    entry(['slides_web'], z.strictObject({ markdown: z.string() }), more),
    entry(['slides_pdf', 'reading_native', 'reading_pdf'], fileSource, more),
    entry(['notebook'], fileSource.extend({ data }), more),
    entry(['shiny'], shinyFile, more),
  ] as const;
/** Each file that is stored as an object; a notebook's data files stand before the notebook. */
const files = z.array(
  z.strictObject({
    path: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.int().min(0),
    format: z.enum(['markdown', 'html', 'pdf', 'notebook', 'data']),
  }),
);
const inTree = { visibility, overlay: z.boolean() };
const shown = { visibility: z.literal('visible') };

/**
 * The operator's manifest (§7): every resource with its source, a definition parsed and its code
 * files filled in. Topics stand in `position` order, resources in entry order, which is their
 * position; paths are from the course folder, with `/`. The upload rules (§8) are not restated.
 */
export const courseManifest = z.strictObject({
  title: courseMeta.shape.title,
  public: z.boolean(),
  topics: z.array(
    z.strictObject({
      ...topicFields,
      completionRule,
      resources: z.array(
        z.discriminatedUnion('type', [
          ...withSource(inTree),
          entry(['exercise'], z.strictObject({ definition: exerciseV1 }), inTree),
          entry(['test'], z.strictObject({ definition: testV1 }), inTree),
        ]),
      ),
    }),
  ),
  files,
});
export type CourseManifest = z.output<typeof courseManifest>;

/**
 * The manifest a site build receives (§7), an allow-list: the visible resources only, no
 * completion rule (it can name a hidden resource), and of an exercise or a test only that it is
 * there: no field holds a definition, a source, a code file, an answer, feedback or a rubric.
 */
export const siteManifest = z.strictObject({
  title: courseMeta.shape.title,
  topics: z.array(
    z.strictObject({
      ...topicFields,
      resources: z.array(
        z.discriminatedUnion('type', [
          ...withSource(shown),
          z.strictObject({ id: folderId, title, ...shown, type: z.literal(['exercise', 'test']) }),
        ]),
      ),
    }),
  ),
  files,
});
export type SiteManifest = z.output<typeof siteManifest>;

/** The first line of a sync bundle (§10); the bytes of `manifest.files` follow it, in order. */
export const syncHeader = z.strictObject({
  /** The address in `instructor.yaml`, and that file's path for messages. */
  instructor: z.strictObject({ email: z.email(), path: z.string() }),
  /** The course folder's name, as the directory listing spells it (§4.2). */
  course: z.string().min(1),
  manifest: courseManifest,
  options: z.strictObject({ overwriteEditor: z.boolean(), acceptNewIds: z.boolean() }),
});
export type SyncHeader = z.output<typeof syncHeader>;

/** What the caller stored for a file: its key and, for a notebook's data file, its object id and size. */
export type StoredFile = { key: string; id?: string; size?: number };
type Json = Record<string, unknown>;
/** What `revisionPayload` reads of a resource: an entry of either manifest that has a source. */
type Sourced<R = CourseManifest['topics'][number]['resources'][number]> = R extends {
  type: infer T;
  source: infer S;
}
  ? { type: T; source: S; alternative?: string }
  : never;

/**
 * The revision fields `sync` and a level 0 build store for a resource, as the editor's forms post
 * them (the table of §10). `stored` gives what the caller stored for a file of the manifest; for a
 * notebook with data files that is the notebook `declareWorkspaceFiles` gives.
 */
export function revisionPayload(resource: Sourced, stored: (file: string) => StoredFile) {
  const { type, source, alternative } = resource;
  const accessibleAlternative = alternative === undefined ? null : { text: alternative };
  const fields = { type: type as ResourceType, accessibleAlternative };
  const body = (content: Json, objectKeys: string[] = []) => ({ ...fields, content, objectKeys });
  if (type === 'slides_web') {
    // One text for a deck saved with a byte-order mark and CRLF and the same deck saved with LF.
    const text =
      source.markdown.charCodeAt(0) === 0xfeff ? source.markdown.slice(1) : source.markdown;
    return body({ markdown: text.replace(/\r\n?/g, '\n') });
  }
  if (type === 'shiny') return body({ url: source.url });
  if (type === 'exercise' || type === 'test') return body(source.definition);
  const { key } = stored(source.file);
  if (type === 'notebook') {
    const objects = source.data.map(({ path, file }) => {
      const { key: dataKey, id, size } = stored(file);
      if (id === undefined || size === undefined)
        throw new Error(`no object id or size for ${file}`);
      return { key: dataKey, declared: { path, resourceId: id, size } };
    });
    const workspaceFiles = objects.map((object) => object.declared);
    const content = { sourceKey: key, ...(objects.length > 0 && { workspaceFiles }) };
    return body(content, [key, ...objects.map((object) => object.key)]);
  }
  if (type !== 'reading_native') return body({ objectKey: key }, [key]);
  const format = source.file.toLowerCase().endsWith('.html') ? 'html' : 'markdown';
  return body({ sourceKey: key, format }, [key]);
}

/**
 * A topic's fields as the draft services store them (§3): an absent field as the editor's empty
 * form gives it, and both kinds of reference as row ids, which `rowId` gives for a folder id.
 */
export function topicPayload(
  topic: Omit<TopicMeta, 'id' | 'resources'>,
  rowId: (kind: 'topic' | 'resource', folderId: string) => string,
) {
  const rule = topic.completionRule?.requires.map((requirement) => {
    const id = REQUIREMENT.exec(requirement)?.[1];
    return id === undefined ? requirement : `submitted:${rowId('resource', id)}`;
  });
  return {
    position: topic.position,
    title: topic.title,
    objective: topic.objective ?? '',
    estimatedMinutes: topic.estimatedMinutes ?? null,
    prerequisites: (topic.prerequisites ?? []).map((id) => rowId('topic', id)),
    completionRule: rule ? { requires: rule } : null,
  };
}

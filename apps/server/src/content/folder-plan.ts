import {
  CourseFileRefused,
  type CourseManifest,
  checkCourseFile,
  type revisionPayload,
  topicPayload,
} from '@parallax/contracts';
import type * as drafts from '@parallax/contracts/routes/drafts';
import type { z } from 'zod';
import { canonical, revisionHash } from './canonical';
import { folderRowId, isFolderRow } from './folder-ids';

/**
 * The comparison of `parallax sync` (docs/design/course-folder.md §10, steps 4 and 5) and its stop
 * for a changed id (§4.4), with no database: the caller reads the drafts, and writes what the plan
 * says through the draft services only when it holds no refusal.
 */

type Json = Record<string, unknown>;
type Head = Pick<
  z.output<typeof drafts.resourceRevisionView>,
  'content' | 'objectKeys' | 'accessibleAlternative' | 'provenance'
>;
type Input<R extends { body?: unknown }> = z.output<NonNullable<R['body']>>;

/** The course's drafts, archived ones included, each resource with its head revision. */
export type SyncState = {
  courseId: string;
  /** The course folder's name as the listing spells it (§4.2), which provenance records. */
  folder: string;
  topics: Omit<z.output<typeof drafts.draftTopic>, 'courseId' | 'updatedAt'>[];
  resources: (Omit<
    z.output<typeof drafts.draftResourceSummary>,
    'courseId' | 'releaseAt' | 'headRevisionId' | 'updatedAt'
  > & { head: Head | null })[];
};
export type SyncOptions = { overwriteEditor: boolean; acceptNewIds: boolean };
export type SyncStep =
  | { op: 'createTopic'; id: string; input: Input<typeof drafts.createTopic> }
  | { op: 'updateTopic'; id: string; input: Input<typeof drafts.updateTopic> }
  | {
      op: 'createResource';
      id: string;
      topicId: string;
      input: Input<typeof drafts.createResource>;
    }
  | { op: 'updateResource'; id: string; input: Input<typeof drafts.updateResource> };
/** Why the run stops before a draft is written; `path` is the file's, from the course folder. */
export type Refusal = { path?: string; message: string };
export type SyncPlan = {
  /** In the order to write them: topics, then resources, then what is archived. */
  steps: SyncStep[];
  refusals: Refusal[];
  /** New ids created at the path where an earlier id was recorded, under `acceptNewIds`. */
  replaced: { path: string; earlier: string; id: string }[];
  /** Live topics and resources made in the editor (random ids), left as they are. */
  editorOnly: number;
};

const digestOf = (type: string, { content, objectKeys, accessibleAlternative }: Head) =>
  revisionHash(type, { content, objectKeys, accessibleAlternative, provenance: null });

/** A head came from the folder: its provenance says so, with the digest of what it stores. */
export function isFolderHead(type: string, head: Head | null): boolean {
  return head?.provenance?.source === 'folder' && head.provenance.digest === digestOf(type, head);
}

/** The fields of `want` that differ from `have`, and the restore of an archived row. */
function changes<T extends Json>(want: T, have: Json & { archived: boolean }) {
  const diff = Object.entries(want).filter(
    ([key, value]) => canonical(value) !== canonical(have[key]),
  );
  const fields = Object.fromEntries(diff) as Partial<T>;
  return have.archived ? { ...fields, archived: false } : fields;
}

const UNPAIRED = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const unstorable = (value: unknown): boolean =>
  typeof value === 'string'
    ? value.includes('\0') || UNPAIRED.test(value)
    : typeof value === 'object' &&
      value !== null &&
      Object.entries(value).some(([key, item]) => unstorable(key) || unstorable(item));

/**
 * Why text the plan would store cannot be stored, before any draft is written. A web deck, whose
 * text the manifest carries and no file stream sees, is held to the rules of an uploaded Markdown
 * file, with their sentences. Any other text, a definition's code files included, must hold no
 * NUL, which PostgreSQL does not store, and no unpaired surrogate, which encodes no text.
 */
function textProblem(value: unknown, deck?: string): string | undefined {
  try {
    if (deck !== undefined && UNPAIRED.test(deck)) return 'The text is not valid UTF-8';
    if (deck !== undefined) checkCourseFile('markdown', new TextEncoder().encode(deck));
  } catch (error) {
    if (error instanceof CourseFileRefused) return error.message;
    throw error;
  }
  return unstorable(value) ? 'The text holds a NUL or an unpaired surrogate' : undefined;
}

const EDITOR_HEAD = 'its head revision was saved in the editor; sync with --overwrite-editor to';

/**
 * The plan for the drafts in `state` to hold what `manifest` declares (§10, "Which side wins").
 * `payloads` gives, by a resource's folder id, what `revisionPayload` built from the stored files.
 */
export function planSync(
  state: SyncState,
  manifest: CourseManifest,
  payloads: ReadonlyMap<string, ReturnType<typeof revisionPayload>>,
  options: SyncOptions,
): SyncPlan {
  const row = (kind: 'topic' | 'resource', id: string) => folderRowId(state.courseId, kind, id);
  const plan: SyncPlan = { steps: [], refusals: [], replaced: [], editorOnly: 0 };
  const topics = new Map(state.topics.map((t) => [t.id, t]));
  const resources = new Map(state.resources.map((r) => [r.id, r]));
  const listed = new Set<string>();

  for (const topic of manifest.topics) {
    const id = row('topic', topic.id);
    for (const entry of [id, ...topic.resources.map((r) => row('resource', r.id))])
      listed.add(entry);
    const fields = topicPayload(topic, row);
    const problem = textProblem(fields);
    if (problem) plan.refusals.push({ message: `topic ${topic.id}: ${problem}` });
    const have = topics.get(id);
    if (!have) {
      plan.steps.push({ op: 'createTopic', id, input: fields });
      continue;
    }
    const input = { expectedRevision: have.revision, ...changes(fields, have) };
    if (Object.keys(input).length > 1) plan.steps.push({ op: 'updateTopic', id, input });
  }

  for (const topic of manifest.topics) {
    for (const [position, entry] of topic.resources.entries()) {
      const refuse = (message: string) => plan.refusals.push({ path: entry.path, message });
      const id = row('resource', entry.id);
      const payload = payloads.get(entry.id);
      if (!payload) throw new Error(`no payload for ${entry.path}`);
      const { type, ...revision } = payload;
      const deck = entry.type === 'slides_web' ? entry.source.markdown : undefined;
      const problem = textProblem([entry.title, revision], deck);
      if (problem) {
        refuse(problem);
        continue;
      }
      const digest = digestOf(type, { ...revision, provenance: null });
      const { path, overlay } = entry;
      const ids = { topic: topic.id, resource: entry.id };
      const provenance = { source: 'folder', course: state.folder, ...ids, path, overlay, digest };
      const topicId = row('topic', topic.id);
      const fields = { title: entry.title, position, visibility: entry.visibility };
      const have = resources.get(id);
      if (!have) {
        // §4.4: a resource this folder made, no longer listed, that recorded this path last.
        const earlier = state.resources.find(
          (r) =>
            !r.archived &&
            isFolderRow(r.id) &&
            !listed.has(r.id) &&
            r.head?.provenance?.source === 'folder' &&
            r.head.provenance.path === path,
        )?.head?.provenance?.resource;
        if (earlier !== undefined) {
          const was = String(earlier);
          if (!options.acceptNewIds) {
            refuse(
              `${entry.id} stands where ${was} was recorded: put ${was} back, or sync with --accept-new-ids`,
            );
            continue;
          }
          plan.replaced.push({ path, earlier: was, id: entry.id });
        }
        const input = { type, ...fields, ...revision, provenance };
        plan.steps.push({ op: 'createResource', id, topicId, input });
        continue;
      }
      if (have.type !== type) {
        refuse(
          `${entry.id} is a ${have.type} resource and keeps its type: give the entry a new id`,
        );
        continue;
      }
      const same = have.head !== null && digestOf(type, have.head) === digest;
      const folders = isFolderHead(type, have.head);
      if (!same && have.head && !folders && !options.overwriteEditor) {
        refuse(`${EDITOR_HEAD} replace it`);
        continue;
      }
      // Unchanged content sends no revision field; an editor's equal head gets the folder's.
      const content = same && folders ? {} : { ...revision, provenance };
      const changed = { ...changes({ topicId, ...fields }, have), ...content };
      const input = { expectedRevision: have.revision, ...changed };
      if (Object.keys(input).length > 1) plan.steps.push({ op: 'updateResource', id, input });
    }
  }

  const archives: SyncStep[] = [];
  const archive = (r: { revision: number }) => ({ expectedRevision: r.revision, archived: true });
  for (const have of state.resources) {
    if (have.archived || listed.has(have.id)) continue;
    if (!isFolderRow(have.id)) plan.editorOnly += 1;
    else if (have.head && !isFolderHead(have.type, have.head) && !options.overwriteEditor) {
      const path = String(have.head.provenance?.path ?? have.title);
      plan.refusals.push({ path, message: `no longer listed, and ${EDITOR_HEAD} archive it` });
    } else archives.push({ op: 'updateResource', id: have.id, input: archive(have) });
  }
  for (const have of state.topics) {
    if (have.archived || listed.has(have.id)) continue;
    const made = state.resources.filter(
      (r) => r.topicId === have.id && !r.archived && !isFolderRow(r.id),
    );
    if (!isFolderRow(have.id)) plan.editorOnly += 1;
    else if (made.length > 0 && !options.overwriteEditor) {
      const titles = made.map((r) => `"${r.title}"`).join(', ');
      const message = `the topic "${have.title}" is no longer listed and holds ${titles}, made in the editor`;
      plan.refusals.push({ message: `${message}; sync with --overwrite-editor to archive it` });
    } else archives.push({ op: 'updateTopic', id: have.id, input: archive(have) });
  }
  plan.steps.push(...archives);
  return plan;
}

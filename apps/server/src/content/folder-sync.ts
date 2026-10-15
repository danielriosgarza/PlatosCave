import {
  type CourseFileFormat,
  CourseFileRefused,
  type CourseManifest,
  checkCourseFile,
  revisionPayload,
  type StoredFile,
  type SyncHeader,
  storedContentTypes,
} from '@parallax/contracts';
import type { CourseScope } from '../auth/scope';
import type { Db } from '../db/client';
import { createResource, createTopic, updateResource, updateTopic } from '../db/content/drafts';
import type { ValidationReport } from '../db/content/releases';
import * as sync from '../db/content/sync';
import { courseObjectId } from '../db/storage/objects';
import { uniqueViolation } from '../db/unique';
import { storeCourseObject } from '../storage/objects';
import type { Body, Storage } from '../storage/storage';
import { folderRowId } from './folder-ids';
import { BundleMismatch, checkedFile, notebookWithData } from './folder-input';
import { planSync, type SyncStep } from './folder-plan';
import { convertAndPublish, type PublishDeps } from './publish-drafts';

/**
 * One run of `parallax sync` for one course (docs/design/course-folder.md §10, steps 1 to 8),
 * with the report the command prints and the exit code it ends with. It builds no query: the
 * data access is the draft services' and `db/content/sync.ts`'s. It writes no audit event of its
 * own, as `apply` does: `createCourse` and `publishRelease` write theirs, naming the owner, and
 * each revision's provenance says that it came from a folder. An error it throws (the database,
 * the queue or storage unavailable) leaves what a stop after step 6 leaves: run it again.
 */

export interface SyncDeps extends PublishDeps {
  storage: Storage;
  /** The server's `INSTRUCTOR_EMAILS`: a course is created only for these addresses. */
  instructorEmails: readonly string[];
  now?: () => Date;
}

/** The bytes of one file of `manifest.files`; each is asked for once, in the manifest's order. */
export type SyncFiles = (file: CourseManifest['files'][number]) => AsyncIterable<Uint8Array>;

export type SyncResult = {
  /** 0 published or nothing to publish, 1 refused or blocked, 2 a malformed bundle, 3 unfinished. */
  code: 0 | 1 | 2 | 3;
  /** One line per result, each a real one; `published` only after a release was returned. */
  report: string[];
  /** Publication's report, when publication ran or the wait for the conversions ended. */
  validation?: ValidationReport;
};

const REFUSED_COURSE = {
  not_instructor: 'the address is not in INSTRUCTOR_EMAILS, so no course is created for it',
  not_owner: 'the account of the address does not own this course',
  archived: 'the course is archived',
};
const AGAIN = 'run sync again';
const NO_ACCOUNT = 'no active account has this address; that person signs in once first';

/** The format of each file the entries name, by its type and extension (§2). */
function formatsOf(topics: CourseManifest['topics']) {
  const formats = new Map<string, CourseFileFormat>();
  for (const entry of topics.flatMap((topic) => topic.resources)) {
    if (entry.type === 'notebook') {
      for (const data of entry.source.data) formats.set(data.file, 'data');
      formats.set(entry.source.file, 'notebook');
    } else if (entry.type === 'reading_native') {
      formats.set(entry.source.file, /\.html$/i.test(entry.source.file) ? 'html' : 'markdown');
    } else if (entry.type === 'slides_pdf' || entry.type === 'reading_pdf') {
      formats.set(entry.source.file, 'pdf');
    }
  }
  return formats;
}

/** Step 3: each file through the upload rules into storage; a notebook after its data files. */
async function storeFiles(
  deps: SyncDeps,
  scope: CourseScope,
  { files, topics }: CourseManifest,
  bytes: SyncFiles,
) {
  const { db, storage } = deps;
  const stored = new Map<string, StoredFile>();
  const formats = formatsOf(topics);
  if (
    new Set(files.map((file) => file.path)).size !== formats.size ||
    files.length !== formats.size
  ) {
    throw new BundleMismatch('the bundle holds other files than its entries name');
  }
  const notebooks = topics.flatMap((t) =>
    t.resources.flatMap((r) => (r.type === 'notebook' ? [r.source] : [])),
  );
  for (const file of files) {
    if (formats.get(file.path) !== file.format) {
      throw new BundleMismatch(`${file.path}: no ${file.format} file of its entry`);
    }
    const checked = checkedFile(file, bytes(file));
    const data = notebooks.find((source) => source.file === file.path)?.data ?? [];
    try {
      let body: Body = checked;
      if (data.length > 0) {
        // The notebook that is stored names its data files' objects, as the editor's does.
        const ids = data.map(({ path, file: dataFile }) => {
          const resourceId = stored.get(dataFile)?.id;
          if (!resourceId) throw new BundleMismatch(`${dataFile}: stands after its notebook`);
          return { path, resourceId };
        });
        const chunks: Uint8Array[] = [];
        for await (const chunk of checked) chunks.push(chunk);
        const text = new TextDecoder().decode(Buffer.concat(chunks));
        body = new TextEncoder().encode(notebookWithData(text, ids));
        // The editor uploads the declared notebook, so the upload rules hold for it too.
        checkCourseFile('notebook', body);
      }
      const type = storedContentTypes[file.format];
      const put = await storeCourseObject(db, storage, scope, body, type);
      const id = file.format === 'data' && (await courseObjectId(db, scope, put.key));
      stored.set(file.path, { key: put.key, size: put.size, ...(id && { id }) });
    } catch (err) {
      if (err instanceof CourseFileRefused) err.message = `${file.path}: ${err.message}`;
      throw err;
    }
  }
  return stored;
}

/** Step 6, one draft service call; a row another run created meanwhile is a conflict. */
async function write(db: Db, scope: CourseScope, step: SyncStep, at: Date) {
  try {
    if (step.op === 'updateTopic') return await updateTopic(db, scope, step.id, step.input, at);
    if (step.op === 'updateResource')
      return await updateResource(db, scope, step.id, step.input, at);
    if (step.op === 'createResource') {
      return await createResource(db, scope, step.topicId, { id: step.id, ...step.input }, at);
    }
    return { ok: true, value: await createTopic(db, scope, { id: step.id, ...step.input }, at) };
  } catch (err) {
    if (!uniqueViolation(err, 'topics_pkey') && !uniqueViolation(err, 'resources_pkey')) throw err;
    return { ok: false, reason: 'conflict' } as const;
  }
}

export async function syncCourse(
  deps: SyncDeps,
  header: SyncHeader,
  files: SyncFiles,
): Promise<SyncResult> {
  const { db, instructorEmails } = deps;
  const { manifest, course: folder, instructor } = header;
  const stop = (code: SyncResult['code'], ...report: string[]): SyncResult => ({ code, report });

  // 1 and 2. The owner's account, which is never created here, and its course.
  const owner = await sync.findFolderOwner(db, instructor.email);
  if (!owner) return stop(1, `${instructor.path}: ${NO_ACCOUNT}`);
  const course = await sync.ensureFolderCourse(db, owner, folder, manifest.title, instructorEmails);
  if (!course.ok) return stop(1, `${instructor.path}: ${folder}: ${REFUSED_COURSE[course.reason]}`);
  const { scope } = course;

  // 3. Objects.
  let stored: Map<string, StoredFile>;
  try {
    stored = await storeFiles(deps, scope, manifest, files);
  } catch (err) {
    if (err instanceof CourseFileRefused) return stop(1, err.message);
    if (err instanceof BundleMismatch) return stop(2, err.message);
    throw err;
  }

  // 4 and 5. The plan, and its refusals before any draft is written.
  const entries = manifest.topics.flatMap((topic) => topic.resources);
  // Every file an entry names is among the stored ones (`formatsOf`).
  const storedFile = (file: string) => stored.get(file) as StoredFile;
  const payloads = new Map(entries.map((entry) => [entry.id, revisionPayload(entry, storedFile)]));
  const state = await sync.loadSyncState(db, scope, folder);
  const plan = planSync(state, manifest, payloads, header.options);
  const refused = plan.refusals.map((r) => (r.path ? `${r.path}: ${r.message}` : r.message));
  if (refused.length > 0) return stop(1, ...refused);

  // 6. Drafts, each with its row's expected revision, and the fingerprint publication checks.
  const pathOf = new Map(
    entries.map((e) => [folderRowId(scope.courseId, 'resource', e.id), e.path]),
  );
  const at = deps.now?.() ?? new Date();
  for (const step of plan.steps) {
    const outcome = await write(db, scope, step, at);
    if (outcome.ok) continue;
    const where = pathOf.get(step.id) ?? step.id;
    if (outcome.reason === 'invalid') return stop(1, `${where}: ${outcome.message}`);
    return stop(3, `${where}: another save or sync changed this draft first; ${AGAIN}`);
  }
  const fingerprint = await sync.draftFingerprint(db, scope);
  const report = course.created ? [`created course ${folder}`] : [];

  // 7 and 8. Conversion and publication.
  const issues = (validation: ValidationReport) =>
    (['errors', 'warnings'] as const).flatMap((kind) =>
      validation[kind].map(({ code, message, resourceId }) => {
        const path = resourceId && pathOf.get(resourceId);
        return `${kind.slice(0, -1)} ${code}: ${message}${path ? ` (${path})` : ''}`;
      }),
    );
  const withReport = (code: SyncResult['code'], line: string, validation: ValidationReport) => ({
    ...stop(code, ...report, line, ...issues(validation)),
    validation,
  });
  const result = await convertAndPublish(deps, scope, fingerprint);
  switch (result.status) {
    case 'published':
      return withReport(0, `release ${result.release.version} published`, result.report);
    case 'unchanged':
      return stop(0, ...report, 'nothing to publish: the drafts equal the newest release');
    case 'conflict':
      return stop(3, ...report, `not published: a draft changed while sync waited; ${AGAIN}`);
    case 'blocked':
      return withReport(1, 'not published', result.report);
    case 'unfinished': {
      const why = result.reason === 'idle' ? 'no worker took the jobs' : 'they took too long';
      return withReport(3, `not published: ${why}; ${AGAIN}`, result.report);
    }
  }
}

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { DEV_RUNNER_RUNTIMES } from '../../src/config';
import type { Db } from '../../src/db/client';
import { adoptRelease } from '../../src/db/content/adoption';
import { createResource } from '../../src/db/content/drafts';
import { publishRelease } from '../../src/db/content/releases';
import { storageObjects } from '../../src/db/schema';
import { FsStorage } from '../../src/storage/fs';
import { storeCourseObject } from '../../src/storage/objects';
import type { Storage } from '../../src/storage/storage';
import { asClassScope, asCourseScope, ids } from '../fixtures/world';

/**
 * A course notebook for the working-copy and transfer tests (P3-09): an uploaded `.ipynb` whose
 * metadata declares three files — a data file released with the notebook, a hidden check that
 * belongs to the course but not to the notebook, and an object that does not exist — published
 * and adopted by classes A and B.
 */

export const DATA_CSV = Buffer.from('x,y\n1,2\n3,4\n', 'utf8');
export const HIDDEN_CHECKS = Buffer.from('assert answer == 42  # hidden grading check\n', 'utf8');

export function courseNotebook(declared: { path: string; resourceId: string }[]) {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3' },
      language_info: { name: 'python', version: '3.12.4' },
      parallax: { files: declared },
    },
    cells: [
      { id: 'intro', cell_type: 'markdown', metadata: {}, source: '# Repeated samples' },
      {
        id: 'load',
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        source: "import pandas as pd\nframe = pd.read_csv('data/sample.csv')",
        outputs: [],
      },
    ],
  };
}

export interface ConnectedNotebook {
  revisionId: string;
  resourceId: string;
  notebook: ReturnType<typeof courseNotebook>;
  dataKey: string;
  hiddenKey: string;
}

/** File storage in a temporary directory, shared by the relay app and the fixture. */
export async function tempStorage(): Promise<{ storage: Storage; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'parallax-working-copies-'));
  return {
    storage: new FsStorage(dir),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export async function connectedNotebook(
  db: Db,
  storage: Storage,
  now: Date,
): Promise<ConnectedNotebook> {
  const course = asCourseScope(ids.statistics, ids.elena);
  const data = await storeCourseObject(db, storage, course, DATA_CSV, 'text/csv');
  const hidden = await storeCourseObject(db, storage, course, HIDDEN_CHECKS, 'text/x-python');
  const idOf = async (key: string) => {
    const [row] = await db
      .select({ id: storageObjects.id })
      .from(storageObjects)
      .where(eq(storageObjects.key, key));
    if (!row) throw new Error(`no storage object ${key}`);
    return row.id;
  };
  const notebook = courseNotebook([
    { path: 'data/sample.csv', resourceId: await idOf(data.key) },
    { path: 'checks.py', resourceId: await idOf(hidden.key) },
    { path: 'missing.csv', resourceId: '00000000-0000-4000-8000-00000000dead' },
  ]);
  const source = await storeCourseObject(
    db,
    storage,
    course,
    Buffer.from(JSON.stringify(notebook), 'utf8'),
    'application/x-ipynb+json',
  );
  const created = await createResource(
    db,
    course,
    ids.sampling,
    {
      type: 'notebook',
      title: 'Repeated samples',
      content: { sourceKey: source.key },
      // The data file is released with the notebook; the hidden check is not.
      objectKeys: [source.key, data.key],
    },
    now,
  );
  if (!created.ok) throw new Error(JSON.stringify(created));
  const revisionId = created.value.headRevisionId;
  if (!revisionId) throw new Error('the notebook has no head revision');
  const published = await publishRelease(db, course, { runtimes: DEV_RUNNER_RUNTIMES });
  if (!published.ok) throw new Error(JSON.stringify(published.report));
  for (const [classId, instructor] of [
    [ids.classA, ids.priya],
    [ids.classB, ids.marcus],
  ] as const) {
    const adopted = await adoptRelease(
      db,
      asClassScope(classId, ids.statistics, instructor, { releaseId: ids.releaseV1 }),
      { releaseId: published.release.id, expectedReleaseId: ids.releaseV1 },
    );
    if (!adopted.ok) throw new Error(adopted.reason);
  }
  return {
    revisionId,
    resourceId: created.value.id,
    notebook,
    dataKey: data.key,
    hiddenKey: hidden.key,
  };
}

/** The working copy URL of a notebook revision in class A. */
export const workingCopyUrl = (revisionId: string, classId: string = ids.classA) =>
  `/api/classes/${classId}/notebook-working-copies/${revisionId}`;

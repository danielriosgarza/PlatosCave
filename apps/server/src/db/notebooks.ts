import { type StoredNotebook, storedNotebook } from '@parallax/contracts';
import { and, asc, eq } from 'drizzle-orm';
import type { ClassScope } from '../auth/scope';
import { openToStudent } from '../content/availability';
import { findReleaseTopic } from './classTopics';
import type { Db } from './client';
import { readDerivedStatus } from './jobs/derived';
import { releasedRevision } from './readings';
import { releaseResources, resourceRevisions } from './schema';

/**
 * Rendered notebooks of the class's adopted release as the caller may study them (§10.1, §10.7).
 * As for readings and decks, every function takes the resolved `ClassScope`, and a student
 * reaches only visible, released notebooks of an open topic.
 */

export interface NotebookSummary {
  resourceId: string;
  revisionId: string;
  title: string;
}

/** The topic's notebooks in authored order; null when the topic is not open to the caller. */
export async function listTopicNotebooks(
  db: Db,
  scope: ClassScope,
  topicId: string,
  now: Date,
): Promise<{ notebooks: NotebookSummary[] } | null> {
  if (!scope.releaseId) return null;
  const topic = await findReleaseTopic(db, scope, { topicId }, now);
  if (!topic?.open) return null;
  const rows = await db
    .select({
      resourceId: releaseResources.resourceId,
      revisionId: releaseResources.resourceRevisionId,
      title: releaseResources.title,
      type: resourceRevisions.type,
      tab: releaseResources.tab,
      visibility: releaseResources.visibility,
      releaseAt: releaseResources.releaseAt,
    })
    .from(releaseResources)
    .innerJoin(resourceRevisions, eq(resourceRevisions.id, releaseResources.resourceRevisionId))
    .where(
      and(
        eq(releaseResources.releaseId, scope.releaseId),
        eq(releaseResources.releaseTopicId, topic.releaseTopicId),
        eq(releaseResources.tab, 'notebooks'),
      ),
    )
    .orderBy(asc(releaseResources.position));
  const notebooks = rows
    .filter((r) => r.type === 'notebook' && (scope.role !== 'student' || openToStudent(r, now)))
    .map(({ resourceId, revisionId, title }) => ({ resourceId, revisionId, title }));
  return { notebooks };
}

export interface NotebookContent {
  revisionId: string;
  title: string;
  status: 'ready' | 'pending' | 'failed';
  error: string | null;
  sourceKey: string | null;
  /** The rendered notebook; its images and HTML outputs name objects by storage key. */
  notebook: StoredNotebook | null;
  /** Content type of each output object the import stored: the only keys an output may link to. */
  objects: Record<string, string>;
}

/** One notebook the caller may open now, with its import state; null when not found (404). */
export async function loadNotebook(
  db: Db,
  scope: ClassScope,
  revisionId: string,
  now: Date,
): Promise<NotebookContent | null> {
  const row = await releasedRevision(db, scope, revisionId, now);
  if (row?.type !== 'notebook' || row.tab !== 'notebooks') return null;
  const status = readDerivedStatus(row.derived.status, row.createdAt);
  const named = typeof row.content.sourceKey === 'string' ? row.content.sourceKey : null;
  const base = {
    revisionId: row.revisionId,
    title: row.title,
    error:
      status?.state === 'failed' ? (status.error ?? 'The notebook could not be imported') : null,
    sourceKey: named && row.objectKeys.includes(named) ? named : null,
    notebook: null,
    objects: {},
  };
  if (status?.state !== 'ready') {
    return { ...base, status: status?.state === 'failed' ? 'failed' : 'pending' };
  }
  const notebook = storedNotebook.safeParse(row.derived.notebook);
  if (!notebook.success) {
    return { ...base, status: 'failed', error: 'The notebook has no rendered content' };
  }
  const objects: Record<string, string> = {};
  const listed = row.derived.objects;
  if (typeof listed === 'object' && listed !== null) {
    for (const [key, type] of Object.entries(listed)) {
      if (typeof type === 'string') objects[key] = type;
    }
  }
  return { ...base, status: 'ready', notebook: notebook.data, objects };
}

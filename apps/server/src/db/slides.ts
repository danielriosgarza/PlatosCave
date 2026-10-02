import type { ReadingPosition } from '@parallax/contracts/routes/readings';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ClassScope } from '../auth/scope';
import { openToStudent } from '../content/availability';
import { readDerivedStatus } from '../jobs/derived';
import { findReleaseTopic } from './classTopics';
import type { Db } from './client';
import { pdfKey, releasedRevision } from './readings';
import { releaseResources, resourceRevisions, studyPositions } from './schema';
import { forClass } from './scoped';

/**
 * PDF decks of the class's adopted release as the caller may study them (§5, §7), and the slide
 * the caller was at. As for readings, every function takes the resolved `ClassScope`, and a
 * student reaches only visible, released decks of an open topic.
 */

const Place = z.object({ page: z.number(), offset: z.number() });

/** A saved place as stored, or null when the stored JSON is not a page. */
const readPlace = (raw: unknown): ReadingPosition | null => {
  const parsed = Place.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

export interface DeckSummary {
  resourceId: string;
  revisionId: string;
  title: string;
  position: ReadingPosition | null;
}

/** The topic's decks in authored order with the caller's last slides; null when it is not open. */
export async function listTopicDecks(
  db: Db,
  scope: ClassScope,
  topicId: string,
  now: Date,
): Promise<{ decks: DeckSummary[]; lastRevisionId: string | null } | null> {
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
        eq(releaseResources.tab, 'slides'),
      ),
    )
    .orderBy(asc(releaseResources.position));
  const shown = rows.filter(
    (r) => r.type === 'slides_pdf' && (scope.role !== 'student' || openToStudent(r, now)),
  );
  const saved = await db
    .select({ revisionId: studyPositions.resourceRevisionId, position: studyPositions.position })
    .from(studyPositions)
    .where(
      and(
        forClass(scope, studyPositions),
        eq(studyPositions.userId, scope.user.id),
        eq(studyPositions.tab, 'slides'),
      ),
    )
    .orderBy(desc(studyPositions.updatedAt));
  const decks = shown.map((r) => ({
    resourceId: r.resourceId,
    revisionId: r.revisionId,
    title: r.title,
    position: readPlace(saved.find((s) => s.revisionId === r.revisionId)?.position),
  }));
  const last = saved.find((s) => decks.some((d) => d.revisionId === s.revisionId));
  return { decks, lastRevisionId: last?.revisionId ?? null };
}

export interface DeckContent {
  revisionId: string;
  title: string;
  status: 'ready' | 'pending' | 'failed';
  error: string | null;
  sourceKey: string | null;
  /** Storage key and page count of a ready deck. */
  pdf: { key: string; pageCount: number } | null;
}

/** One deck the caller may open now, with its ingestion state; null when not found (404). */
export async function loadDeck(
  db: Db,
  scope: ClassScope,
  revisionId: string,
  now: Date,
): Promise<DeckContent | null> {
  const row = await releasedRevision(db, scope, revisionId, now);
  if (!row || row.type !== 'slides_pdf' || row.tab !== 'slides') return null;
  const status = readDerivedStatus(row.derived.status, row.createdAt);
  const key = pdfKey(row.content, row.objectKeys);
  const base = {
    revisionId: row.revisionId,
    title: row.title,
    error: status?.state === 'failed' ? (status.error ?? 'The deck could not be processed') : null,
    sourceKey: key,
    pdf: null,
  };
  if (status?.state !== 'ready') {
    return { ...base, status: status?.state === 'failed' ? 'failed' : 'pending' };
  }
  const pageCount = row.derived.pageCount;
  if (!key || typeof pageCount !== 'number' || pageCount < 1) {
    return { ...base, status: 'failed', error: 'The deck has no PDF file' };
  }
  return { ...base, status: 'ready', pdf: { key, pageCount } };
}

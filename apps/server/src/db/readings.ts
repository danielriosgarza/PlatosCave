import type { ReadingPosition } from '@parallax/contracts/routes/readings';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { ClassScope } from '../auth/scope';
import { openToStudent } from '../content/availability';
import { readDerivedStatus } from '../jobs/derived';
import { invalid, notFound, type Outcome } from '../outcome';
import { loadClassTopics } from './classTopics';
import type { Db } from './client';
import { releaseResources, resourceRevisions, storageObjects, studyPositions } from './schema';
import { forClass } from './scoped';

/**
 * Readings of the class's adopted release as the caller may study them (§5, §8), and the places
 * the caller stopped in them. Every function takes the resolved `ClassScope`; a student reads
 * only visible, released resources of an open topic, the same gate the media route applies, so
 * a reading that is not listed cannot be fetched or given a position by id (§2).
 */

const READING_TYPES = ['reading_native', 'reading_pdf'] as const;
type ReadingType = (typeof READING_TYPES)[number];
const isReading = (type: string): type is ReadingType =>
  (READING_TYPES as readonly string[]).includes(type);

const kindOf = (type: ReadingType): 'native' | 'pdf' =>
  type === 'reading_native' ? 'native' : 'pdf';

const Position = z.union([
  z.object({ blockId: z.string(), offset: z.number() }),
  z.object({ page: z.number(), offset: z.number() }),
]);

/** A saved position as stored, or null when the stored JSON is not a reading position. */
const readPosition = (raw: unknown): ReadingPosition | null => {
  const parsed = Position.safeParse(raw);
  return parsed.success ? (parsed.data as ReadingPosition) : null;
};

interface ReleasedReading {
  resourceId: string;
  revisionId: string;
  releaseTopicId: string;
  title: string;
  type: (typeof resourceRevisions.$inferSelect)['type'];
  tab: (typeof releaseResources.$inferSelect)['tab'];
  objectKeys: string[];
  content: Record<string, unknown>;
  derived: Record<string, unknown>;
  createdAt: Date;
}

/** Whether the topic holding `releaseTopicId` is open to the caller; instructors always see it. */
async function topicOpen(db: Db, scope: ClassScope, releaseTopicId: string, now: Date) {
  if (scope.role !== 'student') return true;
  const { topics } = await loadClassTopics(db, scope, now);
  const topic = topics.find((t) => t.releaseTopicId === releaseTopicId);
  return topic?.availability.state === 'available' || topic?.availability.state === 'complete';
}

/** One pinned revision of the adopted release the caller may open now, or undefined. */
async function releasedRevision(
  db: Db,
  scope: ClassScope,
  revisionId: string,
  now: Date,
): Promise<ReleasedReading | undefined> {
  if (!scope.releaseId) return undefined;
  const [row] = await db
    .select({
      resourceId: releaseResources.resourceId,
      revisionId: releaseResources.resourceRevisionId,
      releaseTopicId: releaseResources.releaseTopicId,
      title: releaseResources.title,
      tab: releaseResources.tab,
      visibility: releaseResources.visibility,
      releaseAt: releaseResources.releaseAt,
      type: resourceRevisions.type,
      objectKeys: resourceRevisions.objectKeys,
      content: resourceRevisions.content,
      derived: resourceRevisions.derived,
      createdAt: resourceRevisions.createdAt,
    })
    .from(releaseResources)
    .innerJoin(resourceRevisions, eq(resourceRevisions.id, releaseResources.resourceRevisionId))
    .where(
      and(
        eq(releaseResources.releaseId, scope.releaseId),
        eq(releaseResources.resourceRevisionId, revisionId),
        eq(resourceRevisions.courseId, scope.courseId),
      ),
    );
  if (!row) return undefined;
  if (scope.role === 'student' && !openToStudent(row, now)) return undefined;
  if (!(await topicOpen(db, scope, row.releaseTopicId, now))) return undefined;
  const { visibility: _visibility, releaseAt: _releaseAt, ...reading } = row;
  return reading;
}

export interface ReadingSummary {
  resourceId: string;
  revisionId: string;
  title: string;
  kind: 'native' | 'pdf';
  position: ReadingPosition | null;
}

/** The topic's readings in authored order with the caller's places; null when it is not open. */
export async function listTopicReadings(
  db: Db,
  scope: ClassScope,
  topicId: string,
  now: Date,
): Promise<{ readings: ReadingSummary[]; lastRevisionId: string | null } | null> {
  if (!scope.releaseId) return null;
  const { topics } = await loadClassTopics(db, scope, now);
  const topic = topics.find((t) => t.topicId === topicId);
  const open =
    topic?.availability.state === 'available' || topic?.availability.state === 'complete';
  if (!topic || (scope.role === 'student' && !open)) return null;
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
        eq(releaseResources.tab, 'reading'),
      ),
    )
    .orderBy(asc(releaseResources.position));
  const shown = rows.filter((r) => scope.role !== 'student' || openToStudent(r, now));
  const saved = await db
    .select({
      revisionId: studyPositions.resourceRevisionId,
      position: studyPositions.position,
    })
    .from(studyPositions)
    .where(
      and(
        forClass(scope, studyPositions),
        eq(studyPositions.userId, scope.user.id),
        eq(studyPositions.tab, 'reading'),
      ),
    )
    .orderBy(desc(studyPositions.updatedAt));
  const readings: ReadingSummary[] = [];
  for (const r of shown) {
    if (!isReading(r.type)) continue;
    readings.push({
      resourceId: r.resourceId,
      revisionId: r.revisionId,
      title: r.title,
      kind: kindOf(r.type),
      position: readPosition(saved.find((s) => s.revisionId === r.revisionId)?.position),
    });
  }
  const last = saved.find((s) => readings.some((r) => r.revisionId === s.revisionId));
  return { readings, lastRevisionId: last?.revisionId ?? null };
}

export interface ReadingContent {
  revisionId: string;
  title: string;
  kind: 'native' | 'pdf';
  status: 'ready' | 'pending' | 'failed';
  error: string | null;
  /** Stored HTML (images carry `data-object-key`, no `src`) for a ready native reading. */
  html: string | null;
  /** Storage key and page count of a ready PDF reading. */
  pdf: { key: string; pageCount: number } | null;
  /** Content type of each object the revision owns: the only ones an image may resolve to. */
  objects: Record<string, string>;
}

/** One reading the caller may open now, with its ingestion state; null when not found (404). */
export async function loadReading(
  db: Db,
  scope: ClassScope,
  revisionId: string,
  now: Date,
): Promise<ReadingContent | null> {
  const row = await releasedRevision(db, scope, revisionId, now);
  if (!row || !isReading(row.type)) return null;
  const status = readDerivedStatus(row.derived.status, row.createdAt);
  const state = status?.state === 'ready' ? 'ready' : status?.state === 'failed' ? 'failed' : null;
  const stored = row.objectKeys.length
    ? await db
        .select({ key: storageObjects.key, contentType: storageObjects.contentType })
        .from(storageObjects)
        .where(
          and(
            eq(storageObjects.courseId, scope.courseId),
            inArray(storageObjects.key, row.objectKeys),
          ),
        )
    : [];
  const base = {
    revisionId: row.revisionId,
    title: row.title,
    kind: kindOf(row.type),
    error:
      status?.state === 'failed' ? (status.error ?? 'The reading could not be processed') : null,
    objects: Object.fromEntries(stored.map((o) => [o.key, o.contentType])),
    html: null,
    pdf: null,
  };
  if (state !== 'ready') return { ...base, status: state ?? 'pending' };
  if (row.type === 'reading_native') {
    const html = typeof row.derived.html === 'string' ? row.derived.html : null;
    return html === null
      ? { ...base, status: 'failed', error: 'The reading has no rendered content' }
      : { ...base, status: 'ready', html };
  }
  const key = pdfKey(row.content, row.objectKeys);
  const pageCount = row.derived.pageCount;
  if (!key || typeof pageCount !== 'number' || pageCount < 1) {
    return { ...base, status: 'failed', error: 'The reading has no PDF file' };
  }
  return { ...base, status: 'ready', pdf: { key, pageCount } };
}

/** The PDF file of a `reading_pdf` revision: `content.objectKey`, else its only object. */
function pdfKey(content: Record<string, unknown>, objectKeys: string[]): string | null {
  const named = typeof content.objectKey === 'string' ? content.objectKey : undefined;
  const key = named ?? (objectKeys.length === 1 ? objectKeys[0] : undefined);
  return key && objectKeys.includes(key) ? key : null;
}

/**
 * Upserts the caller's place in one reading of the class release. A position that does not fit
 * the reading (a block it does not have, a page past its end, a block for a PDF) is refused, so
 * restoring it never has to guess.
 */
export async function savePosition(
  db: Db,
  scope: ClassScope,
  input: { revisionId: string; tab: string; position: ReadingPosition },
  now: Date,
): Promise<Outcome<{ updatedAt: string }>> {
  const row = await releasedRevision(db, scope, input.revisionId, now);
  if (!row) return notFound;
  if (row.tab !== input.tab) return invalid('The resource is not on that tab');
  if (!isReading(row.type)) return invalid('Positions are only saved for readings here');
  const { position } = input;
  if (row.type === 'reading_native') {
    if (!('blockId' in position)) return invalid('A native reading is positioned by block');
    const blocks = row.derived.blockMap;
    const known =
      Array.isArray(blocks) &&
      blocks.some((b) => (b as { id?: unknown } | null)?.id === position.blockId);
    if (!known) return invalid('The block is not part of this reading');
  } else {
    if (!('page' in position)) return invalid('A PDF reading is positioned by page');
    const pages = row.derived.pageCount;
    if (typeof pages === 'number' && position.page > pages) {
      return invalid('The page is past the end of this reading');
    }
  }
  const values = {
    userId: scope.user.id,
    classId: scope.classId,
    resourceRevisionId: row.revisionId,
    tab: row.tab,
    position,
    updatedAt: now,
  };
  await db
    .insert(studyPositions)
    .values(values)
    .onConflictDoUpdate({
      target: [studyPositions.userId, studyPositions.classId, studyPositions.resourceRevisionId],
      set: { tab: values.tab, position, updatedAt: now },
    });
  return { ok: true, value: { updatedAt: now.toISOString() } };
}

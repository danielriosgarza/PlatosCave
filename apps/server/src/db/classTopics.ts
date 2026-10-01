import { and, asc, desc, eq } from 'drizzle-orm';
import type { ClassScope } from '../auth/scope';
import {
  type AvailabilityTopic,
  computeAvailability,
  firstTab,
  openToStudent,
  TABS,
  type Tab,
  type TopicAvailability,
} from '../content/availability';
import type { Db } from './client';
import { draftSnapshot } from './content/releases';
import {
  classMemberships,
  courseReleases,
  releaseResources,
  releaseTopics,
  studyPositions,
  users,
} from './schema';
import { forClass } from './scoped';

export interface ClassTopic {
  topicId: string;
  releaseTopicId: string;
  number: number;
  title: string;
  objective: string;
  estimatedMinutes: number | null;
  presence: Record<Tab, boolean>;
  firstTab: Tab | null;
  /** Tab of the caller's latest position in this topic that they can still open (§4). */
  savedTab: Tab | null;
  availability: TopicAvailability;
}

export interface ClassTopics {
  release: { id: string; version: number } | null;
  cohort: string;
  instructors: string[];
  topics: ClassTopic[];
  resume: { topicId: string; tab: Tab; saved: boolean } | null;
  reviewedCount: number;
}

/**
 * Topics the caller has completed in this class. Completion rules and reviewed marks arrive with
 * `topic_reviews` (P2-16), which replaces this body; until then nothing can be complete, so the
 * topics behind a prerequisite stay locked for students.
 */
async function completedTopics(_db: Db, _scope: ClassScope): Promise<ReadonlySet<string>> {
  return new Set();
}

/** Names of the class's instructors, excluding preview principals. */
async function instructorNames(db: Db, scope: ClassScope): Promise<string[]> {
  const rows = await db
    .select({ name: users.name })
    .from(classMemberships)
    .innerJoin(users, eq(users.id, classMemberships.userId))
    .where(
      and(
        forClass(scope, classMemberships),
        eq(classMemberships.role, 'instructor'),
        eq(classMemberships.isPreview, false),
      ),
    )
    .orderBy(asc(users.name));
  return rows.map((r) => r.name);
}

/**
 * Topic and resource rows of the class's adopted release, or of the course draft for a draft
 * preview (ADR-0003: a preview principal reads the draft snapshot, never the adopted release).
 */
async function syllabusRows(db: Db, scope: ClassScope) {
  if (scope.membership.isPreview) {
    const draft = await draftSnapshot(db, scope);
    return { release: null, topicRows: draft.topics, resourceRows: draft.resources };
  }
  if (!scope.releaseId) return undefined;
  const [release] = await db
    .select({ id: courseReleases.id, version: courseReleases.version })
    .from(courseReleases)
    .where(
      and(eq(courseReleases.id, scope.releaseId), eq(courseReleases.courseId, scope.courseId)),
    );
  if (!release) return undefined;
  const topicRows = await db
    .select()
    .from(releaseTopics)
    .where(eq(releaseTopics.releaseId, release.id))
    .orderBy(asc(releaseTopics.position));
  const resourceRows = await db
    .select({
      releaseTopicId: releaseResources.releaseTopicId,
      revisionId: releaseResources.resourceRevisionId,
      tab: releaseResources.tab,
      visibility: releaseResources.visibility,
      releaseAt: releaseResources.releaseAt,
    })
    .from(releaseResources)
    .where(eq(releaseResources.releaseId, release.id));
  return { release, topicRows, resourceRows };
}

/**
 * The syllabus of the class's adopted release as the caller may see it (§4): one query path for
 * the topic list and for the download gate, so a UI lock and a media refusal cannot disagree.
 * Reads only the adopted release (ADR-0003); a draft preview reads the draft snapshot instead.
 */
export async function loadClassTopics(db: Db, scope: ClassScope, now: Date): Promise<ClassTopics> {
  const base = { cohort: scope.className, instructors: await instructorNames(db, scope) };
  const empty = { ...base, release: null, topics: [], resume: null, reviewedCount: 0 };
  const source = await syllabusRows(db, scope);
  if (!source) return empty;
  const { release, topicRows, resourceRows } = source;

  const forStudent = scope.role === 'student';
  const inputs: (AvailabilityTopic & { id: string })[] = topicRows.map((t) => ({
    id: t.id,
    topicId: t.topicId,
    title: t.title,
    prerequisites: t.prerequisites,
    resources: resourceRows.filter((r) => r.releaseTopicId === t.id),
  }));
  const completed = await completedTopics(db, scope);
  const availability = computeAvailability(inputs, { role: scope.role, now, completed });

  const topics: ClassTopic[] = topicRows.map((t, index) => {
    const mine = resourceRows.filter((r) => r.releaseTopicId === t.id);
    const shown = forStudent ? mine.filter((r) => openToStudent(r, now)) : mine;
    const presence = Object.fromEntries(
      TABS.map((tab) => [tab, shown.some((r) => r.tab === tab)]),
    ) as Record<Tab, boolean>;
    const found = availability.get(t.topicId);
    if (!found) throw new Error(`no availability for topic ${t.topicId}`);
    return {
      topicId: t.topicId,
      releaseTopicId: t.id,
      number: index + 1,
      title: t.title,
      objective: t.objective,
      estimatedMinutes: t.estimatedMinutes,
      presence,
      firstTab: firstTab(presence),
      savedTab: null,
      availability: found,
    };
  });

  const opens = (t: ClassTopic) =>
    t.availability.state === 'available' || t.availability.state === 'complete';
  const reviewedCount = topics.filter((t) => t.availability.state === 'complete').length;
  const resume = await applySavedPositions(
    db,
    scope,
    topics,
    opens,
    revisionTopics(resourceRows, topicRows),
  );
  return { ...base, release, topics, resume, reviewedCount };
}

/** Release topic and tab of each pinned revision, to place a saved study position. */
function revisionTopics(
  resourceRows: { releaseTopicId: string; revisionId: string; tab: Tab }[],
  topicRows: { id: string; topicId: string }[],
): Map<string, { topicId: string; tab: Tab }> {
  const topicOf = new Map(topicRows.map((t) => [t.id, t.topicId]));
  const out = new Map<string, { topicId: string; tab: Tab }>();
  for (const r of resourceRows) {
    const topicId = topicOf.get(r.releaseTopicId);
    if (topicId) out.set(r.revisionId, { topicId, tab: r.tab });
  }
  return out;
}

/**
 * Places the caller's saved study positions (§4): each open topic gets the tab of its latest
 * position that is still openable (`savedTab`, mutated in place), and Resume leads to the most
 * recent such position, else to the first open topic that has material.
 */
async function applySavedPositions(
  db: Db,
  scope: ClassScope,
  topics: ClassTopic[],
  opens: (t: ClassTopic) => boolean,
  placeOf: Map<string, { topicId: string; tab: Tab }>,
): Promise<ClassTopics['resume']> {
  const open = new Map(topics.filter(opens).map((t) => [t.topicId, t]));
  const saved = await db
    .select({ revisionId: studyPositions.resourceRevisionId })
    .from(studyPositions)
    .where(and(forClass(scope, studyPositions), eq(studyPositions.userId, scope.user.id)))
    .orderBy(desc(studyPositions.updatedAt));
  let resume: ClassTopics['resume'] = null;
  for (const { revisionId } of saved) {
    const place = placeOf.get(revisionId);
    const topic = place && open.get(place.topicId);
    if (!place || !topic?.presence[place.tab] || topic.savedTab) continue;
    topic.savedTab = place.tab;
    resume ??= { topicId: place.topicId, tab: place.tab, saved: true };
  }
  if (resume) return resume;
  const first = topics.find((t) => opens(t) && t.firstTab);
  return first?.firstTab ? { topicId: first.topicId, tab: first.firstTab, saved: false } : null;
}

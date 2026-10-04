import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { type ClassScope, isDraftPreview } from '../auth/scope';
import {
  type AvailabilityTopic,
  computeAvailability,
  firstTab,
  openToStudent,
  TABS,
  type Tab,
  type TopicAvailability,
  topicOpens,
} from '../content/availability';
import type { Db } from './client';
import { type DraftSnapshot, draftSnapshot } from './content/releases';
import {
  classMemberships,
  courseReleases,
  releaseResources,
  releaseTopics,
  studyPositions,
  users,
} from './schema';
import { forClass } from './scoped';
import { completedTopics } from './topicReviews';

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
  if (isDraftPreview(scope)) {
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
 * The syllabus of the class's adopted release as the caller may see it (§4). Availability comes
 * from `computeAvailability`, as in `findReleaseTopic`, so a UI lock and a refusal cannot disagree.
 * Reads only the adopted release (ADR-0003); a draft preview reads the draft snapshot instead.
 */
export async function loadClassTopics(db: Db, scope: ClassScope, now: Date): Promise<ClassTopics> {
  const base = { cohort: scope.className, instructors: await instructorNames(db, scope) };
  const empty = { ...base, release: null, topics: [], resume: null, reviewedCount: 0 };
  const source = await syllabusRows(db, scope);
  if (!source) return empty;
  const { release, topicRows, resourceRows } = source;

  const forStudent = scope.role === 'student';
  const availability = await availabilityOf(db, scope, topicRows, resourceRows, now);

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

  const opens = (t: ClassTopic) => topicOpens(t.availability);
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

type TopicRow = { id: string; topicId: string; title: string; prerequisites: string[] };
type ResourceRow = AvailabilityTopic['resources'][number] & { releaseTopicId: string };

/**
 * Availability (§4) of `topicRows` for the caller, each topic judged by its own rows of
 * `resourceRows`: the one assembly behind `loadClassTopics` and `findReleaseTopic`.
 */
async function availabilityOf(
  db: Db,
  scope: ClassScope,
  topicRows: TopicRow[],
  resourceRows: ResourceRow[],
  now: Date,
  withCompletion = true,
  draftRead?: DraftSnapshot,
) {
  const inputs: AvailabilityTopic[] = topicRows.map((t) => ({
    topicId: t.topicId,
    title: t.title,
    prerequisites: t.prerequisites,
    resources: resourceRows.filter((r) => r.releaseTopicId === t.id),
  }));
  const completed = withCompletion
    ? await completedTopics(db, scope, now, draftRead)
    : new Set<string>();
  return computeAvailability(inputs, { role: scope.role, now, completed });
}

/**
 * One topic of the adopted release (of the draft snapshot for a draft preview), found by its
 * topic id or its release topic id, and whether the caller may open it now. The same
 * availability `loadClassTopics` computes, from only the rows that decide it (the topic, its
 * resources, its prerequisites): the gate for per-request checks such as media downloads and
 * reading positions. Null when there is no such topic. A draft preview's caller may pass the
 * snapshot it already read, so one request reads the draft once.
 */
export async function findReleaseTopic(
  db: Db,
  scope: ClassScope,
  by: { topicId: string } | { releaseTopicId: string },
  now: Date,
  draftRead?: DraftSnapshot,
): Promise<{ topicId: string; releaseTopicId: string; open: boolean } | null> {
  const matches = (t: { id: string; topicId: string }) =>
    'topicId' in by ? t.topicId === by.topicId : t.id === by.releaseTopicId;
  let topic: TopicRow | undefined;
  let resources: ResourceRow[];
  let prerequisites: TopicRow[];
  let draftUsed: DraftSnapshot | undefined;
  if (isDraftPreview(scope)) {
    const draft = draftRead ?? (await draftSnapshot(db, scope));
    draftUsed = draft;
    topic = draft.topics.find(matches);
    if (!topic) return null;
    const id = topic.id;
    const needed = new Set(topic.prerequisites);
    resources = draft.resources.filter((r) => r.releaseTopicId === id);
    prerequisites = draft.topics.filter((t) => needed.has(t.topicId));
  } else {
    if (!scope.releaseId) return null;
    [topic] = await db
      .select({
        id: releaseTopics.id,
        topicId: releaseTopics.topicId,
        title: releaseTopics.title,
        prerequisites: releaseTopics.prerequisites,
      })
      .from(releaseTopics)
      .innerJoin(courseReleases, eq(courseReleases.id, releaseTopics.releaseId))
      .where(
        and(
          eq(releaseTopics.releaseId, scope.releaseId),
          eq(courseReleases.courseId, scope.courseId),
          'topicId' in by
            ? eq(releaseTopics.topicId, by.topicId)
            : eq(releaseTopics.id, by.releaseTopicId),
        ),
      );
    if (!topic) return null;
    if (scope.role !== 'student') {
      return { topicId: topic.topicId, releaseTopicId: topic.id, open: true };
    }
    const releaseId = scope.releaseId;
    const id = topic.id;
    // Prerequisites only need to exist in the release and carry a title; their resources do not
    // bear on this topic's state. The two reads are independent.
    [resources, prerequisites] = await Promise.all([
      db
        .select({
          releaseTopicId: releaseResources.releaseTopicId,
          tab: releaseResources.tab,
          visibility: releaseResources.visibility,
          releaseAt: releaseResources.releaseAt,
        })
        .from(releaseResources)
        .where(
          and(eq(releaseResources.releaseId, releaseId), eq(releaseResources.releaseTopicId, id)),
        ),
      topic.prerequisites.length
        ? db
            .select({
              id: releaseTopics.id,
              topicId: releaseTopics.topicId,
              title: releaseTopics.title,
              prerequisites: releaseTopics.prerequisites,
            })
            .from(releaseTopics)
            .where(
              and(
                eq(releaseTopics.releaseId, releaseId),
                inArray(releaseTopics.topicId, topic.prerequisites),
              ),
            )
        : Promise.resolve([]),
    ]);
  }
  // A prerequisite's own prerequisites and resources do not bear on this topic's state.
  const shown = prerequisites.map((p) => ({ ...p, prerequisites: [] }));
  const availability = await availabilityOf(
    db,
    scope,
    [topic, ...shown],
    resources,
    now,
    // Only a prerequisite's completion can change whether the topic opens.
    topic.prerequisites.length > 0,
    draftUsed,
  );
  const state = availability.get(topic.topicId);
  return {
    topicId: topic.topicId,
    releaseTopicId: topic.id,
    open: state !== undefined && topicOpens(state),
  };
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

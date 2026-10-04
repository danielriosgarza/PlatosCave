import type * as contracts from '@parallax/contracts/routes/topicReviews';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { type ClassScope, isDraftPreview } from '../auth/scope';
import { openToStudent, type Tab } from '../content/availability';
import { classArchived, invalid, notFound, type Outcome } from '../outcome';
import type { Db } from './client';
import { draftSnapshot } from './content/releases';
import {
  courseReleases,
  notebookSubmissions,
  releaseResources,
  releaseTopics,
  resourceRevisions,
  topicReviews,
} from './schema';
import { forClass } from './scoped';

/**
 * Reviewed marks and topic completion (§4). A student marks ungraded material reviewed; graded
 * work counts only through a submission. Completion is the course author's rule, shown to the
 * student, and is not a grade. Reading or viewing never writes a mark.
 */

export type TopicReviews = z.input<typeof contracts.topicReviews>;

/** Resource types whose credit comes from a submission, not from the student's own mark. */
const GRADED = new Set<string>(['test']);
/** The requirement that every ungraded resource of the topic is reviewed. */
export const ALL_REVIEWED = 'reviewed:*';

export interface RuleTopic {
  id: string;
  topicId: string;
  completionRule: Record<string, unknown> | null;
}
export interface RuleResource {
  releaseTopicId: string;
  resourceId: string;
  type: string;
  tab: Tab;
  title: string;
  visibility: 'visible' | 'hidden';
  releaseAt: Date | null;
}

/** What the caller has done: marks they made and resources they submitted. */
export interface Evidence {
  reviewed: ReadonlySet<string>;
  submitted: ReadonlySet<string>;
}

/** The requirements of a topic: its custom list, else every ungraded resource reviewed. */
export function requirementsOf(topic: RuleTopic): string[] {
  const requires = topic.completionRule?.requires;
  if (topic.completionRule === null) return [ALL_REVIEWED];
  return Array.isArray(requires) ? requires.filter((r): r is string => typeof r === 'string') : [];
}

/** The resource a `submitted:<id>` requirement names, if the requirement has that shape. */
const submittedId = (requirement: string) =>
  requirement.startsWith('submitted:') ? requirement.slice('submitted:'.length) : null;

/**
 * One line per thing the topic asks of the student, each met or not. A topic with nothing to
 * ask (no ungraded material, or an empty custom list) is never complete, so it cannot unlock
 * its dependents by default. An unknown requirement is never met.
 */
export function checksOf(topic: RuleTopic, studyable: RuleResource[], evidence: Evidence) {
  const checks: { resourceId: string | null; met: boolean }[] = [];
  for (const requirement of requirementsOf(topic)) {
    if (requirement === ALL_REVIEWED) {
      for (const r of studyable) {
        if (!GRADED.has(r.type)) {
          checks.push({ resourceId: r.resourceId, met: evidence.reviewed.has(r.resourceId) });
        }
      }
      continue;
    }
    const id = submittedId(requirement);
    if (id !== null) {
      const there = studyable.some((r) => r.resourceId === id);
      checks.push({ resourceId: id, met: there && evidence.submitted.has(id) });
      continue;
    }
    checks.push({ resourceId: null, met: false });
  }
  return checks;
}

/** Topics of the syllabus the evidence completes: the one evaluation behind every count. */
export function completedFrom(
  topics: RuleTopic[],
  resources: RuleResource[],
  evidence: Evidence,
  now: Date,
): Set<string> {
  const done = new Set<string>();
  for (const topic of topics) {
    const studyable = resources.filter(
      (r) => r.releaseTopicId === topic.id && openToStudent(r, now),
    );
    const checks = checksOf(topic, studyable, evidence);
    if (checks.length > 0 && checks.every((c) => c.met)) done.add(topic.topicId);
  }
  return done;
}

/** The caller's evidence in one class. */
async function evidenceOf(db: Db, classId: string, userId: string): Promise<Evidence> {
  const marks = await db
    .select({ resourceId: topicReviews.resourceId })
    .from(topicReviews)
    .where(and(eq(topicReviews.classId, classId), eq(topicReviews.userId, userId)));
  const submissions = await db
    .selectDistinct({ resourceId: notebookSubmissions.resourceId })
    .from(notebookSubmissions)
    .where(and(eq(notebookSubmissions.classId, classId), eq(notebookSubmissions.userId, userId)));
  return {
    reviewed: new Set(marks.map((m) => m.resourceId)),
    submitted: new Set(submissions.map((s) => s.resourceId)),
  };
}

/** Topic and resource rows of an adopted release, shaped for the completion rule. */
export async function releaseRuleRows(db: Db, releaseId: string, courseId: string) {
  const topicRows = await db
    .select({
      id: releaseTopics.id,
      topicId: releaseTopics.topicId,
      completionRule: releaseTopics.completionRule,
    })
    .from(releaseTopics)
    .innerJoin(courseReleases, eq(courseReleases.id, releaseTopics.releaseId))
    .where(and(eq(releaseTopics.releaseId, releaseId), eq(courseReleases.courseId, courseId)));
  const resourceRows = await db
    .select({
      releaseTopicId: releaseResources.releaseTopicId,
      resourceId: releaseResources.resourceId,
      type: resourceRevisions.type,
      tab: releaseResources.tab,
      title: releaseResources.title,
      visibility: releaseResources.visibility,
      releaseAt: releaseResources.releaseAt,
    })
    .from(releaseResources)
    .innerJoin(resourceRevisions, eq(resourceRevisions.id, releaseResources.resourceRevisionId))
    .where(eq(releaseResources.releaseId, releaseId));
  return { topicRows, resourceRows };
}

/** Completed topic ids of a student in one class of the adopted release (cards and counts). */
export async function completedInClass(
  db: Db,
  who: { classId: string; userId: string; releaseId: string; courseId: string },
  now: Date,
): Promise<Set<string>> {
  const { topicRows, resourceRows } = await releaseRuleRows(db, who.releaseId, who.courseId);
  const evidence = await evidenceOf(db, who.classId, who.userId);
  return completedFrom(topicRows, resourceRows, evidence, now);
}

/**
 * Topics the caller has completed in this class. Instructors keep no study progress. A draft
 * preview is judged on the draft snapshot it studies.
 */
export async function completedTopics(
  db: Db,
  scope: ClassScope,
  now: Date,
): Promise<ReadonlySet<string>> {
  if (scope.role !== 'student') return new Set();
  const evidence = await evidenceOf(db, scope.classId, scope.user.id);
  if (isDraftPreview(scope)) {
    const draft = await draftSnapshot(db, scope);
    return completedFrom(draft.topics, draft.resources, evidence, now);
  }
  if (!scope.releaseId) return new Set();
  const { topicRows, resourceRows } = await releaseRuleRows(db, scope.releaseId, scope.courseId);
  return completedFrom(topicRows, resourceRows, evidence, now);
}

/** The caller's review sheet for one topic, or undefined when the topic is not theirs to open. */
async function sheet(
  db: Db,
  scope: ClassScope,
  topicId: string,
  now: Date,
): Promise<{ reply: TopicReviews; resources: RuleResource[] } | undefined> {
  let topics: RuleTopic[];
  let resources: RuleResource[];
  if (isDraftPreview(scope)) {
    const draft = await draftSnapshot(db, scope);
    topics = draft.topics;
    resources = draft.resources;
  } else {
    if (!scope.releaseId) return undefined;
    ({ topicRows: topics, resourceRows: resources } = await releaseRuleRows(
      db,
      scope.releaseId,
      scope.courseId,
    ));
  }
  const topic = topics.find((t) => t.topicId === topicId);
  if (!topic) return undefined;
  const evidence = await evidenceOf(db, scope.classId, scope.user.id);
  const studyable = resources.filter((r) => r.releaseTopicId === topic.id && openToStudent(r, now));
  const required = new Set(
    requirementsOf(topic).flatMap((r) => {
      const id = submittedId(r);
      return id ? [id] : [];
    }),
  );
  const allReviewed = requirementsOf(topic).includes(ALL_REVIEWED);
  const items = studyable.map((r) => {
    const graded = GRADED.has(r.type);
    const submitted = evidence.submitted.has(r.resourceId);
    return {
      resourceId: r.resourceId,
      title: r.title,
      tab: r.tab,
      graded,
      reviewed: !graded && evidence.reviewed.has(r.resourceId),
      submitted,
      required: required.has(r.resourceId)
        ? ('submission' as const)
        : allReviewed && !graded
          ? ('review' as const)
          : null,
    };
  });
  const complete = completedFrom([topic], resources, evidence, now).has(topic.topicId);
  return { reply: { topicId, complete, items }, resources: studyable };
}

export async function loadTopicReviews(
  db: Db,
  scope: ClassScope,
  topicId: string,
  now: Date,
): Promise<TopicReviews | undefined> {
  return (await sheet(db, scope, topicId, now))?.reply;
}

/**
 * Sets or clears the caller's reviewed mark on one ungraded resource of an open topic. Graded
 * material takes no mark: it counts through submissions (§4). An archived class keeps its marks.
 */
export async function setReviewed(
  db: Db,
  scope: ClassScope,
  input: { topicId: string; resourceId: string; reviewed: boolean },
  now: Date,
): Promise<Outcome<TopicReviews>> {
  if (scope.role !== 'student') return notFound;
  const before = await sheet(db, scope, input.topicId, now);
  const item = before?.reply.items.find((i) => i.resourceId === input.resourceId);
  if (!before || !item) return notFound;
  if (scope.archived) return classArchived;
  if (item.graded) {
    return invalid('Graded work counts through its submission, not through a reviewed mark');
  }
  if (input.reviewed) {
    await db
      .insert(topicReviews)
      .values({
        classId: scope.classId,
        userId: scope.user.id,
        isPreview: scope.membership.isPreview,
        topicId: input.topicId,
        resourceId: input.resourceId,
        createdAt: now,
      })
      .onConflictDoNothing();
  } else {
    await db
      .delete(topicReviews)
      .where(
        and(
          forClass(scope, topicReviews),
          eq(topicReviews.userId, scope.user.id),
          eq(topicReviews.resourceId, input.resourceId),
        ),
      );
  }
  const after = await sheet(db, scope, input.topicId, now);
  return after ? { ok: true, value: after.reply } : notFound;
}

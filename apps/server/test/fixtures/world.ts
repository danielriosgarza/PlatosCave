import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { ClassManagerScope, ClassScope, CourseScope, UserScope } from '../../src/auth/scope';
import { sessionCookieHeader } from '../../src/auth/sessions';
import { DEV_SESSION_SECRET } from '../../src/config';
import { createSession } from '../../src/db/auth/sessions';
import type { Db } from '../../src/db/client';
import { adoptRelease } from '../../src/db/content/adoption';
import { publishRelease } from '../../src/db/content/releases';
import {
  createClass,
  createCourse,
  createPreviewPrincipal,
  createUser,
} from '../../src/db/identity';
import { acceptInstructorInvite, issueInvite, joinWithCode } from '../../src/db/invites';
import { setManageMembers, setPublisher } from '../../src/db/members';
import { classes, resourceRevisions, resources, topics, users } from '../../src/db/schema';

/** Deterministic fixture ids: `…-4000-8000-0000000000NN`. */
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

export const ids = {
  elena: id(1), // owns Statistical thinking; no class membership
  marcus: id(2), // instructor of class B
  priya: id(3), // teaches class A and studies in class B
  sam: id(4), // student in class A
  bea: id(5), // student in class B
  olivia: id(6), // owns Linear models only
  previewB: id(7), // Marcus's preview principal in class B
  noor: id(8), // instructor of class A holding manage_members
  ines: id(9), // publisher of Statistical thinking; no class membership
  statistics: id(101),
  linearModels: id(102),
  classA: id(201),
  classB: id(202),
  sampling: id(301), // topic 1 of Statistical thinking
  estimation: id(302), // topic 2
  samplingReading: id(401), // reading_native in Sampling
  samplingQuiz: id(402), // test in Sampling
  answerKey: id(403), // hidden reading_native in Estimation
  samplingReadingV1: id(501),
  samplingQuizV1: id(502),
  answerKeyV1: id(503),
  releaseV1: id(601), // Statistical thinking v1, adopted by classes A and B
} as const;

export type PersonName =
  | 'elena'
  | 'marcus'
  | 'priya'
  | 'sam'
  | 'bea'
  | 'olivia'
  | 'previewB'
  | 'noor'
  | 'ines';
export const people: PersonName[] = [
  'elena',
  'marcus',
  'priya',
  'sam',
  'bea',
  'olivia',
  'previewB',
  'noor',
  'ines',
];

/** The Cookie header a browser sends for `token`, signed with the non-production secret. */
export const cookieFor = (token: string): string => sessionCookieHeader(token, DEV_SESSION_SECRET);

export interface World {
  ids: typeof ids;
  /** Session cookie header per person, authenticated at `now`. */
  cookie: Record<PersonName, string>;
}

/**
 * The standard world (ADR-0002): course *Statistical thinking* with classes A and B, owner
 * Elena, Marcus teaching B, students in each class, Priya teaching A and studying in B, Noor
 * teaching A with the membership-management grant, Ines publishing the course without teaching,
 * and a second course owned by Olivia. People join through invitations and enrolment codes. Release v1 of Statistical thinking (two topics, one hidden
 * resource) is adopted by classes A and B. Built through the service functions the API uses.
 */
export async function buildWorld(db: Db, now = new Date()): Promise<World> {
  const person = (key: PersonName, name: string) =>
    createUser(db, { id: ids[key as keyof typeof ids], email: `${key}@example.test`, name });
  await person('elena', 'Elena Ruiz');
  await person('marcus', 'Marcus Webb');
  await person('priya', 'Priya Nair');
  await person('sam', 'Sam Okafor');
  await person('bea', 'Bea Lindqvist');
  await person('olivia', 'Olivia Hart');
  await person('noor', 'Noor Haddad');
  await person('ines', 'Ines Moreau');

  await createCourse(db, { id: ids.statistics, title: 'Statistical thinking', ownerId: ids.elena });
  await createCourse(db, { id: ids.linearModels, title: 'Linear models', ownerId: ids.olivia });
  const course = ids.statistics;
  const owner = asCourseScope(course, ids.elena);
  await createClass(db, owner, { id: ids.classA, name: 'Autumn 2026 A' });
  await createClass(db, owner, { id: ids.classB, name: 'Autumn 2026 B' });
  const teach = async (classId: string, who: PersonName) => {
    const scope = asManagerScope(classId, course, ids.elena);
    const email = `${who}@example.test`;
    const issued = await issueInvite(db, scope, { kind: 'instructor', email }, now);
    if (!issued.ok) throw new Error(`world invite: ${issued.reason}`);
    const accepted = await acceptInstructorInvite(
      db,
      asUserScope(ids[who], email),
      issued.invite.code,
      now,
    );
    if (!accepted.ok) throw new Error(`world accept: ${accepted.reason}`);
  };
  const enrol = async (classId: string, students: PersonName[]) => {
    const scope = asManagerScope(classId, course, ids.elena);
    const issued = await issueInvite(db, scope, { kind: 'enrolment' }, now);
    if (!issued.ok) throw new Error(`world code: ${issued.reason}`);
    for (const who of students) {
      const joined = await joinWithCode(
        db,
        asUserScope(ids[who], `${who}@example.test`),
        issued.invite.code,
        now,
      );
      if (!joined.ok) throw new Error(`world join: ${joined.reason}`);
    }
  };
  await teach(ids.classA, 'priya');
  await teach(ids.classB, 'marcus');
  await teach(ids.classA, 'noor');
  await setManageMembers(db, asManagerScope(ids.classA, course, ids.elena), ids.noor, true, now);
  await setPublisher(db, owner, ids.ines, true);
  await enrol(ids.classA, ['sam']);
  await enrol(ids.classB, ['bea', 'priya']);
  await createPreviewPrincipal(db, asClassScope(ids.classB, course, ids.marcus), {
    id: ids.previewB,
  });

  await seedDrafts(db);
  const published = await publishRelease(db, asCourseScope(course, ids.elena), {
    id: ids.releaseV1,
  });
  if (!published.ok) throw new Error(`world release: ${JSON.stringify(published.report)}`);
  for (const [classId, instructor] of [
    [ids.classA, ids.priya],
    [ids.classB, ids.marcus],
  ] as const) {
    const adopted = await adoptRelease(db, asClassScope(classId, course, instructor), {
      releaseId: ids.releaseV1,
      expectedReleaseId: null,
    });
    if (!adopted.ok) throw new Error(`world adoption: ${adopted.reason}`);
  }

  const cookie = {} as Record<PersonName, string>;
  for (const key of people) {
    const { token } = await createSession(db, ids[key], { now });
    cookie[key] = cookieFor(token);
  }
  return { ids, cookie };
}

/**
 * Builds the world unless it exists (the e2e fixture route, ADR-0006); true when it built it.
 * Throws on a half-built world: adopting v1 in class B is the build's last data step.
 */
export async function ensureWorld(db: Db, now: Date): Promise<boolean> {
  const [started] = await db.select({ id: users.id }).from(users).where(eq(users.id, ids.elena));
  if (!started) {
    await buildWorld(db, now);
    return true;
  }
  const [done] = await db
    .select({ id: classes.id })
    .from(classes)
    .where(and(eq(classes.id, ids.classB), eq(classes.releaseId, ids.releaseV1)));
  if (!done) throw new Error('the fixture world is half built; reset the e2e database');
  return false;
}

/**
 * Scope objects for fixture code acting as a person outside a request. The brand is type-only
 * (ADR-0002), so only test code builds them this way; routes get theirs from the resolver.
 */
export const asCourseScope = (courseId: string, userId: string) =>
  ({ courseId, user: { id: userId } }) as unknown as CourseScope;
export const asManagerScope = (classId: string, courseId: string, userId: string) =>
  ({
    classId,
    courseId,
    archived: false,
    via: 'course_owner',
    user: { id: userId },
  }) as unknown as ClassManagerScope;
export const asUserScope = (userId: string, email: string) =>
  ({ user: { id: userId, email, kind: 'user' } }) as unknown as UserScope;
export const asClassScope = (
  classId: string,
  courseId: string,
  userId: string,
  extra: { role?: 'student' | 'instructor'; releaseId?: string | null } = {},
) =>
  ({
    classId,
    courseId,
    role: extra.role ?? 'instructor',
    releaseId: extra.releaseId ?? null,
    user: { id: userId },
  }) as unknown as ClassScope;

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Draft content of Statistical thinking: Sampling (a reading and a quiz) and Estimation (a
 * hidden answer key). Inserted directly until the draft API (P1-04a) offers service functions.
 */
async function seedDrafts(db: Db): Promise<void> {
  const course = ids.statistics;
  const createdBy = ids.elena;
  await db.insert(topics).values([
    { id: ids.sampling, courseId: course, position: 0, title: 'Sampling', createdBy },
    {
      id: ids.estimation,
      courseId: course,
      position: 1,
      title: 'Estimation',
      prerequisites: [ids.sampling],
      createdBy,
    },
  ]);
  const drafts = [
    {
      id: ids.samplingReading,
      revisionId: ids.samplingReadingV1,
      topicId: ids.sampling,
      type: 'reading_native' as const,
      title: 'Why samples vary',
      position: 0,
      content: { html: '<p>Every sample tells a slightly different story.</p>' },
    },
    {
      id: ids.samplingQuiz,
      revisionId: ids.samplingQuizV1,
      topicId: ids.sampling,
      type: 'test' as const,
      title: 'Sampling quiz',
      position: 1,
      content: { questions: [{ id: 'q1', prompt: 'What is a sampling distribution?' }] },
    },
    {
      id: ids.answerKey,
      revisionId: ids.answerKeyV1,
      topicId: ids.estimation,
      type: 'reading_native' as const,
      title: 'Answer key',
      position: 0,
      visibility: 'hidden' as const,
      content: { html: '<p>q1: the distribution of a statistic over samples.</p>' },
    },
  ];
  for (const { revisionId, content, ...resource } of drafts) {
    await db.insert(resources).values({ ...resource, courseId: course, createdBy });
    await db.insert(resourceRevisions).values({
      id: revisionId,
      resourceId: resource.id,
      courseId: course,
      type: resource.type,
      content,
      contentHash: sha256(content),
      createdBy,
    });
    await db
      .update(resources)
      .set({ headRevisionId: revisionId })
      .where(eq(resources.id, resource.id));
  }
}

import { createSession, sessionCookieHeader } from '../../src/auth/sessions';
import { DEV_SESSION_SECRET } from '../../src/config';
import type { Db } from '../../src/db/client';
import {
  addInstructor,
  addStudent,
  createClass,
  createCourse,
  createPreviewPrincipal,
  createUser,
} from '../../src/db/identity';

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
  statistics: id(101),
  linearModels: id(102),
  classA: id(201),
  classB: id(202),
} as const;

export type PersonName = 'elena' | 'marcus' | 'priya' | 'sam' | 'bea' | 'olivia' | 'previewB';
export const people: PersonName[] = [
  'elena',
  'marcus',
  'priya',
  'sam',
  'bea',
  'olivia',
  'previewB',
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
 * Elena, Marcus teaching B, students in each class, Priya teaching A and studying in B, and a
 * second course owned by Olivia. Built through the same service functions the API uses.
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

  await createCourse(db, { id: ids.statistics, title: 'Statistical thinking', ownerId: ids.elena });
  await createCourse(db, { id: ids.linearModels, title: 'Linear models', ownerId: ids.olivia });
  const course = ids.statistics;
  await createClass(db, ids.elena, { id: ids.classA, courseId: course, name: 'Autumn 2026 A' });
  await createClass(db, ids.elena, { id: ids.classB, courseId: course, name: 'Autumn 2026 B' });
  await addInstructor(db, ids.elena, ids.classA, ids.priya);
  await addInstructor(db, ids.elena, ids.classB, ids.marcus);
  await addStudent(db, null, ids.classA, ids.sam);
  await addStudent(db, null, ids.classB, ids.bea);
  await addStudent(db, null, ids.classB, ids.priya);
  await createPreviewPrincipal(db, {
    id: ids.previewB,
    instructorId: ids.marcus,
    classId: ids.classB,
  });

  const cookie = {} as Record<PersonName, string>;
  for (const key of people) {
    const { token } = await createSession(db, ids[key], { now });
    cookie[key] = cookieFor(token);
  }
  return { ids, cookie };
}

import { z } from 'zod';
import { anchor } from '../anchors';
import { classArchived, courseArchived, defineRoute } from '../define';
import { exampleIds } from '../examples';

/**
 * Data lifecycle (§4, §8, §12, §13): archive and restore of classes and courses, a person's own
 * annotation export, and deactivation or deletion of their own account. An archived class or
 * course keeps read access for its members and refuses writes; registerRoute answers every
 * other write with 409 `class_archived` / `course_archived` before the handler runs.
 */

const timestamp = z.iso.datetime({ offset: true });
const classParams = z.object({ classId: z.uuid() });
const courseParams = z.object({ courseId: z.uuid() });

const notArchived = z.object({ error: z.literal('not_archived') });

/** The state a class or course archive call leaves behind. */
export const archiveState = z.object({ id: z.uuid(), archived: z.boolean() });

/**
 * Archives the class; audited as `class.archive`. Members keep reading everything they could
 * read; every write answers 409 `class_archived`. Needs the course owner or a membership-management
 * grant (§3), the same people who manage the class's membership. 409 `class_archived` when it is
 * archived already, or its course is.
 */
export const archiveClass = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/archive',
  scope: { kind: 'class', role: 'instructor', grant: 'manage_members' },
  summary: 'Archive a class; members keep read access',
  params: classParams,
  response: archiveState,
  errors: { 409: classArchived },
  examples: { params: { classId: exampleIds.zero } },
});

/**
 * Restores an archived class; audited as `class.restore`. 409 `not_archived` when the class is
 * not archived, 409 `course_archived` while its course is: restore the course first.
 */
export const restoreClass = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/restore',
  scope: { kind: 'class', role: 'instructor', grant: 'manage_members' },
  summary: 'Restore an archived class',
  params: classParams,
  response: archiveState,
  allowWhenArchived: true,
  errors: { 409: z.union([notArchived, courseArchived]) },
  examples: { params: { classId: exampleIds.zero } },
});

/**
 * Archives the course; audited as `course.archive`. Its classes become read-only with it, its
 * draft stops taking edits and publications (409 `course_archived`), and everyone keeps reading.
 * Owner only. 409 `course_archived` when it is archived already.
 */
export const archiveCourse = defineRoute({
  method: 'POST',
  path: '/api/courses/:courseId/archive',
  scope: { kind: 'course', role: 'owner' },
  summary: 'Archive a course and, with it, every class of the course',
  params: courseParams,
  response: archiveState,
  errors: { 409: courseArchived },
  examples: { params: { courseId: exampleIds.zero } },
});

/**
 * Restores an archived course; audited as `course.restore`. Classes archived on their own stay
 * archived. Owner only. 409 `not_archived` when the course is not archived.
 */
export const restoreCourse = defineRoute({
  method: 'POST',
  path: '/api/courses/:courseId/restore',
  scope: { kind: 'course', role: 'owner' },
  summary: 'Restore an archived course',
  params: courseParams,
  response: archiveState,
  allowWhenArchived: true,
  errors: { 409: notArchived },
  examples: { params: { courseId: exampleIds.zero } },
});

const exportedDrawing = z.object({
  /** A standalone SVG document; its `desc` carries the description the author wrote. */
  svg: z.string(),
  description: z.string().nullable(),
});

export const exportedAnnotation = z.object({
  id: z.uuid(),
  kind: z.enum(['highlight', 'note', 'sketch']),
  /** The note text, or a sketch's description; null for a highlight without a note. */
  body: z.string().nullable(),
  resourceTitle: z.string(),
  topicTitle: z.string(),
  /** Where the mark sits, in words a person can find again ("page 3", "figure fig-1"). */
  source: z.object({
    resourceId: z.uuid(),
    resourceRevisionId: z.uuid(),
    anchor: anchor,
    reference: z.string(),
    quote: z.string().nullable(),
  }),
  drawing: exportedDrawing.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const exportedPost = z.object({
  id: z.uuid(),
  threadId: z.uuid(),
  audience: z.enum(['instructor', 'class']),
  resourceTitle: z.string(),
  /** Null once the post was deleted: its tombstone keeps the place, not the words. */
  body: z.string().nullable(),
  createdAt: timestamp,
});

/**
 * The caller's own annotations in the class (text, resource title, source reference and
 * drawings as SVG, §8) and their own discussion posts. Nobody else's notes and no one else's
 * class are in it, so a member of two classes exports each separately. Reads keep working in an
 * archived class. Audited as `export.annotations`.
 */
export const exportAnnotations = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/export/annotations',
  scope: { kind: 'class', role: 'any' },
  summary: 'Export your own annotations and posts in this class',
  params: classParams,
  response: z.object({
    exportedAt: timestamp,
    class: z.object({ id: z.uuid(), name: z.string() }),
    course: z.object({ id: z.uuid(), title: z.string() }),
    annotations: z.array(exportedAnnotation),
    posts: z.array(exportedPost),
  }),
  examples: { params: { classId: exampleIds.zero } },
});

/**
 * The people whose accounts cannot be closed yet: whoever owns a live (not archived) course
 * must archive it first, because a course without an owner could not be managed (§3).
 */
const ownsCourses = z.object({ error: z.literal('owns_courses') });

const accountBody = z.object({ confirm: z.literal(true) });
const accountResult = z.object({ deactivatedAt: timestamp });

/**
 * Deactivates the caller's account (§13): every session ends, their connectors are revoked (§10.6),
 * sign-in links no longer work for the address, and a retention grace period starts after which
 * the identity is anonymised. Needs a recent sign-in (401 `recent_auth_required`); a preview
 * principal gets 403. 409 `owns_courses` while they own a live course. Audited as
 * `account.deactivate`.
 */
export const deactivateAccount = defineRoute({
  method: 'POST',
  path: '/api/me/deactivate',
  scope: { kind: 'user' },
  summary: 'Deactivate your own account',
  body: accountBody,
  response: accountResult,
  errors: { 403: z.object({ error: z.literal('forbidden') }), 409: ownsCourses },
  examples: { body: { confirm: true } },
});

/**
 * Deletes the caller's account as far as the organisation allows (§13, plan decision 23): the
 * identity is replaced by a pseudonym, private annotations are deleted, sessions end and
 * connectors are revoked. Grades, submissions, shared posts and audit rows remain under the
 * pseudonym until a retention policy removes them. Same conditions as deactivation; audited as
 * `account.delete`.
 */
export const deleteAccount = defineRoute({
  method: 'POST',
  path: '/api/me/delete',
  scope: { kind: 'user' },
  summary: 'Delete your own account and anonymise your identity',
  body: accountBody,
  response: accountResult,
  errors: { 403: z.object({ error: z.literal('forbidden') }), 409: ownsCourses },
  examples: { body: { confirm: true } },
});

export { classArchived, courseArchived };

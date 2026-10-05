import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { resourceRevisions, resources } from './content';
import { classes } from './memberships';
import { notebookSessions, notebookWorkingCopies } from './notebook-sessions';
import { users } from './users';

/**
 * Notebooks a student handed in from outside Parallax, for instance from a Colab working copy
 * (§10.5, §10.7, §13). A row is one explicit submission: the uploaded `.ipynb` is frozen in
 * storage after the upload was acknowledged, and the row pins the resource revision the class
 * studied, so review shows what was handed in and against which notebook. Resubmitting adds the
 * next version; no row or object is changed or erased (a trigger rejects updates and direct
 * deletes). It records no grade and no claim about where the notebook was run.
 */
export const notebookSubmissions = pgTable(
  'notebook_submissions',
  {
    id: uuid().primaryKey().defaultRandom(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Written by a preview principal; review excludes it. */
    isPreview: boolean().notNull().default(false),
    resourceId: uuid()
      .notNull()
      .references(() => resources.id),
    /** The notebook revision the class studied when the file was handed in. */
    resourceRevisionId: uuid()
      .notNull()
      .references(() => resourceRevisions.id),
    /** 1 for the first submission of this notebook by this student, then one more each time. */
    version: integer().notNull(),
    /** The client's idempotency key: sending the same request again returns the same receipt. */
    submissionKey: text().notNull(),
    /** Storage key of the frozen snapshot, under `classes/<classId>/submissions/`. */
    objectKey: text().notNull(),
    sha256: text().notNull(),
    size: bigint({ mode: 'number' }).notNull(),
    /** The file name as the student's computer gave it, without directories. */
    filename: text().notNull(),
    /**
     * What the file itself says about where it was made: `{ runtime, kernel, language,
     * languageVersion, nbformat }`. Declared by the file, so not trusted as a fact about the
     * machine (§10.5).
     */
    environment: jsonb().$type<Record<string, string | number>>().notNull().default({}),
    /**
     * A notebook submitted from a connected session (P3-09): the working copy and acknowledged
     * revision it froze, and the session whose environment it records. Null for an upload.
     */
    workingCopyId: uuid().references((): AnyPgColumn => notebookWorkingCopies.id),
    workingCopyRevision: integer(),
    sessionId: uuid().references((): AnyPgColumn => notebookSessions.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.classId, t.userId, t.resourceId, t.version),
    unique().on(t.classId, t.userId, t.resourceId, t.submissionKey),
    index().on(t.classId, t.resourceId),
    check('notebook_submissions_version', sql`${t.version} >= 1`),
    check('notebook_submissions_size', sql`${t.size} > 0`),
  ],
);

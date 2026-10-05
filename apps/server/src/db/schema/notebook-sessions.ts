import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { connectors, notebookConnections } from './connectors';
import { resourceRevisions } from './content';
import { classes } from './memberships';
import { notebookSubmissions } from './notebookSubmissions';
import { users } from './users';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/**
 * Notebook sessions, executions, working copies and file transfers (docs/design/connector.md
 * §10.2). Every table is class data: it carries `class_id` and is read only through a resolved
 * class scope (ADR-0002). Class files (working-copy revisions, copied-out files) are stored by
 * key under `classes/<classId>/…`, as notebook submissions are (P2-14); `storage_objects` holds
 * course content only.
 */

export const notebookSessionState = pgEnum('notebook_session_state', [
  'starting',
  'ready',
  'disconnected',
  'unconfirmed',
  'stopping',
  'stopped',
  'failed',
]);
export const cellExecutionState = pgEnum('cell_execution_state', [
  'sent',
  'running',
  'ok',
  'error',
  'aborted',
  'incomplete',
  'unconfirmed',
]);
export const workingCopySource = pgEnum('working_copy_source', ['browser', 'import', 'server']);
export const fileTransferDirection = pgEnum('file_transfer_direction', ['in', 'out']);
export const fileTransferState = pgEnum('file_transfer_state', [
  'started',
  'done',
  'failed',
  'conflict',
]);

/** A person's working copy of one course notebook in one class (P3-09, §11). */
export const notebookWorkingCopies = pgTable(
  'notebook_working_copies',
  {
    id: uuid().primaryKey().defaultRandom(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sourceRevisionId: uuid()
      .notNull()
      .references(() => resourceRevisions.id),
    currentRevision: integer().notNull().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.userId, t.classId, t.sourceRevisionId),
    check('notebook_working_copies_revision', sql`${t.currentRevision} >= 1`),
  ],
);

/** One saved revision of a working copy; revision 1 is the course notebook. */
export const notebookWorkingCopyRevisions = pgTable(
  'notebook_working_copy_revisions',
  {
    workingCopyId: uuid()
      .notNull()
      .references(() => notebookWorkingCopies.id, { onDelete: 'cascade' }),
    revision: integer().notNull(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    /** Storage key under `classes/<classId>/working-copies/`. */
    objectKey: text().notNull(),
    sha256: text().notNull(),
    size: bigint({ mode: 'number' }).notNull(),
    source: workingCopySource().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workingCopyId, t.revision] }),
    index().on(t.classId),
    check('notebook_working_copy_revisions_revision', sql`${t.revision} >= 1`),
  ],
);

/**
 * One notebook session (§2, §10.7): a Jupyter server opened through a connector for one person
 * and one notebook of a class. The server never stops a session itself; `state` moves only by
 * `nextSessionState` (relay/session-state.ts).
 */
export const notebookSessions = pgTable(
  'notebook_sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connectionId: uuid()
      .notNull()
      .references(() => notebookConnections.id, { onDelete: 'cascade' }),
    connectorId: uuid()
      .notNull()
      .references(() => connectors.id, { onDelete: 'cascade' }),
    resourceRevisionId: uuid()
      .notNull()
      .references(() => resourceRevisions.id),
    workingCopyId: uuid().references(() => notebookWorkingCopies.id),
    state: notebookSessionState().notNull(),
    /** A loss cause of §5.5 or the catalogue code a session failed with. */
    cause: text(),
    /** Whether the connector started the process (and so may stop it), per its last report. */
    owned: boolean().notNull(),
    /** `{ mode, kernelName?, kernelspecs? }`. */
    runtime: jsonb().$type<Record<string, unknown>>().notNull(),
    environment: jsonb().$type<Record<string, string>>(),
    jupyterVersion: text(),
    lease: jsonb().$type<{ idleTimeoutMin: number; gracePeriodMin: number }>().notNull(),
    leaseExpiresAt: timestamp({ withTimezone: true }),
    kernelId: text(),
    kernelName: text(),
    kernelGeneration: integer().notNull().default(0),
    lastHeartbeatAt: timestamp({ withTimezone: true }),
    lastConfirmedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    stoppedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    // An unreachable session is left with Forget (§10.7), so it never blocks a new one.
    uniqueIndex('notebook_sessions_open_key')
      .on(t.userId, t.classId, t.resourceRevisionId)
      .where(sql`${t.state} not in ('stopped', 'failed')`),
    index('notebook_sessions_connector_open_idx')
      .on(t.connectorId)
      .where(sql`${t.state} not in ('stopped', 'failed')`),
    index().on(t.classId, t.userId),
    check(
      'notebook_sessions_stopped_at',
      sql`(${t.state} in ('stopped', 'failed')) = (${t.stoppedAt} is not null)`,
    ),
  ],
);

/** One cell sent to a kernel (P3-06a, §10.6); `client_ref` makes a resent execute harmless. */
export const cellExecutions = pgTable(
  'cell_executions',
  {
    id: uuid().primaryKey().defaultRandom(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    sessionId: uuid()
      .notNull()
      .references(() => notebookSessions.id, { onDelete: 'cascade' }),
    clientRef: uuid().notNull(),
    seq: bigint({ mode: 'number' }).notNull(),
    cellId: text().notNull(),
    resourceRevisionId: uuid()
      .notNull()
      .references(() => resourceRevisions.id),
    workingCopyRevision: integer(),
    codeHash: bytea().notNull(),
    kernelId: text().notNull(),
    kernelGeneration: integer().notNull(),
    msgId: uuid().notNull().unique(),
    state: cellExecutionState().notNull(),
    executionCount: integer(),
    outputsIncomplete: boolean().notNull().default(false),
    sentAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique().on(t.sessionId, t.clientRef),
    unique().on(t.sessionId, t.seq),
    index().on(t.classId),
    check('cell_executions_code_hash', sql`octet_length(${t.codeHash}) = 32`),
  ],
);

/** A file copied into the workspace or out of it (P3-09, §11). */
export const fileTransfers = pgTable(
  'file_transfers',
  {
    id: uuid().primaryKey().defaultRandom(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    sessionId: uuid()
      .notNull()
      .references(() => notebookSessions.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    direction: fileTransferDirection().notNull(),
    /** Relative to the session's workspace. */
    path: text().notNull(),
    sha256: text().notNull(),
    size: bigint({ mode: 'number' }).notNull(),
    state: fileTransferState().notNull(),
    /** Storage key under `classes/<classId>/transfers/` once copied out. */
    objectKey: text(),
    conflict: jsonb(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.classId), index().on(t.sessionId)],
);

/** The transferred files frozen with a notebook submission (P3-09, §11). */
export const notebookSubmissionFiles = pgTable(
  'notebook_submission_files',
  {
    submissionId: uuid()
      .notNull()
      .references(() => notebookSubmissions.id, { onDelete: 'cascade' }),
    path: text().notNull(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    fileTransferId: uuid()
      .notNull()
      .references(() => fileTransfers.id),
    sha256: text().notNull(),
    size: bigint({ mode: 'number' }).notNull(),
    objectKey: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.submissionId, t.path] }), index().on(t.classId)],
);

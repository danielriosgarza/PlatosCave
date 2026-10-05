import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { ClassScope } from '../../auth/scope';
import { audit } from '../audit';
import type { Db, Executor } from '../client';
import { fileTransfers, notebookSessions } from '../schema';
import { forClass } from '../scoped';
import type { OwnedSession } from './sessions';

/**
 * File transfers of notebook sessions (docs/design/connector.md §11). A row records one file
 * copied into a session's workspace or out of it; it reads `done` only once the connector
 * acknowledged the write or Parallax stored the bytes. Rows are the caller's own, read through
 * their class scope. What the person chose and what was found at the destination is kept in
 * `conflict` as `TransferDetail`.
 */

export type TransferRow = typeof fileTransfers.$inferSelect;

export type TransferKind = 'copy_in' | 'save' | 'import' | 'copy_out';
export type TransferOutcome = 'copied' | 'unchanged' | 'kept_theirs' | 'replaced' | 'saved_copy';

/** What the `conflict` column holds. */
export interface TransferDetail {
  kind: TransferKind;
  outcome?: TransferOutcome;
  /** The file found at the destination. */
  remote?: { sha256: string; size: number };
  error?: string;
  /** For an import: the working-copy revision it created. */
  revision?: number;
}

const mine = (scope: ClassScope) =>
  and(forClass(scope, fileTransfers), eq(fileTransfers.userId, scope.user.id));

export const transferDetail = (row: TransferRow): TransferDetail =>
  (row.conflict ?? { kind: row.direction === 'in' ? 'copy_in' : 'copy_out' }) as TransferDetail;

export interface FinishedTransfer {
  direction: 'in' | 'out';
  path: string;
  sha256: string;
  size: number;
  state: 'done' | 'failed' | 'conflict';
  detail: TransferDetail;
  objectKey?: string;
}

/**
 * Records a transfer of the caller's session once its outcome is known, with the audit event
 * of a `done` copy (`transfer.copied_in` for data written to the workspace, `transfer.copied_out`
 * for data Parallax received).
 */
export async function recordTransfer(
  db: Db,
  scope: ClassScope,
  session: OwnedSession,
  input: FinishedTransfer,
  started: Date,
  now: Date,
): Promise<TransferRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(fileTransfers)
      .values({
        classId: scope.classId,
        sessionId: session.id,
        userId: scope.user.id,
        direction: input.direction,
        path: input.path,
        sha256: input.sha256,
        size: input.size,
        state: input.state,
        objectKey: input.objectKey ?? null,
        conflict: input.detail,
        createdAt: started,
        finishedAt: input.state === 'conflict' ? null : now,
      })
      .returning();
    if (!row) throw new Error('file transfer insert returned no row');
    const wrote =
      input.detail.outcome && !['unchanged', 'kept_theirs'].includes(input.detail.outcome);
    if (input.state === 'done' && wrote && !scope.membership.isPreview) {
      await audit(tx, {
        actorId: scope.user.id,
        action: input.direction === 'in' ? 'transfer.copied_in' : 'transfer.copied_out',
        scopeKind: 'class',
        scopeId: scope.classId,
        targetType: 'file_transfer',
        targetId: row.id,
        after: {
          sessionId: session.id,
          kind: input.detail.kind,
          path: input.path,
          sha256: input.sha256,
          size: input.size,
        },
        createdAt: now,
      });
    }
    return row;
  });
}

/** The caller's transfers of one of their sessions, newest first (at most 200). */
export function sessionTransfers(
  db: Executor,
  scope: ClassScope,
  session: OwnedSession,
): Promise<TransferRow[]> {
  return db
    .select()
    .from(fileTransfers)
    .where(and(mine(scope), eq(fileTransfers.sessionId, session.id)))
    .orderBy(desc(fileTransfers.createdAt), desc(fileTransfers.id))
    .limit(200);
}

/** One transfer of one of the caller's sessions; null for anyone else's. */
export async function findTransfer(
  db: Executor,
  scope: ClassScope,
  session: OwnedSession,
  transferId: string,
): Promise<TransferRow | null> {
  const [row] = await db
    .select()
    .from(fileTransfers)
    .where(
      and(mine(scope), eq(fileTransfers.sessionId, session.id), eq(fileTransfers.id, transferId)),
    );
  return row ?? null;
}

/** Bytes Parallax already stored from this session's workspace (the 200 MiB budget). */
export async function copiedOutBytes(
  db: Executor,
  scope: ClassScope,
  session: OwnedSession,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${fileTransfers.size}), 0)` })
    .from(fileTransfers)
    .where(
      and(
        mine(scope),
        eq(fileTransfers.sessionId, session.id),
        eq(fileTransfers.direction, 'out'),
        eq(fileTransfers.state, 'done'),
        sql`${fileTransfers.objectKey} is not null`,
      ),
    );
  return Number(row?.total ?? 0);
}

/**
 * The caller's finished copy-outs among `ids`, from their sessions on `sourceRevisionId`: what a
 * submission may freeze. Anything else (another notebook's, a conflict, a failure, an import,
 * someone else's) is absent from the answer.
 */
export async function submittableTransfers(
  db: Executor,
  scope: ClassScope,
  sourceRevisionId: string,
  ids: string[],
): Promise<TransferRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ transfer: fileTransfers })
    .from(fileTransfers)
    .innerJoin(
      notebookSessions,
      and(
        eq(notebookSessions.id, fileTransfers.sessionId),
        eq(notebookSessions.classId, fileTransfers.classId),
      ),
    )
    .where(
      and(
        mine(scope),
        inArray(fileTransfers.id, ids),
        eq(fileTransfers.direction, 'out'),
        eq(fileTransfers.state, 'done'),
        sql`${fileTransfers.objectKey} is not null`,
        eq(notebookSessions.userId, scope.user.id),
        eq(notebookSessions.resourceRevisionId, sourceRevisionId),
      ),
    );
  return rows.map((r) => r.transfer);
}

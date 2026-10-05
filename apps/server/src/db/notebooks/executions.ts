import { createHash } from 'node:crypto';
import { and, asc, eq, gt, inArray, max, sql } from 'drizzle-orm';
import type { ClassScope } from '../../auth/scope';
import type { Db, Tx } from '../client';
import { cellExecutions, notebookSessions } from '../schema';
import { findSession, type OwnedSession, type SessionRow } from './sessions';

/**
 * Cell executions of notebook sessions (docs/design/connector.md §10.2, §10.6). An execution is
 * bound once, by the browser's `client_ref`: a second `execute` with the same ref reads the row
 * it made and sends nothing, so a resent request after a reconnect never runs a cell twice. The
 * relay never resends an `execute_request`; every later change only moves the row's state.
 *
 * The person reads executions through their own class scope. The relay changes rows of sessions
 * it already holds (an `OwnedSession` or the session of the connector whose link reported it).
 */

export type ExecutionRow = typeof cellExecutions.$inferSelect;
export type ExecutionStateName = ExecutionRow['state'];

/** States an execution can still leave because the kernel may still answer it. */
export const OPEN_EXECUTION_STATES = ['sent', 'running', 'unconfirmed'] as const;
const IN_FLIGHT = ['sent', 'running'] as const;

export type BindResult =
  | { kind: 'created'; row: ExecutionRow }
  | { kind: 'existing'; row: ExecutionRow }
  | { kind: 'not_ready' };

/**
 * Binds one `execute` (§10.6 step 2) in one transaction: the row of an existing `ref` is
 * answered as it is; otherwise, when the session is `ready` and still on `kernel` at
 * `generation`, a `sent` row with the next `seq`, a fresh `msg_id` and the code's SHA-256.
 * With `kernel` null (the relay cannot send now) only an existing ref is answered.
 */
export function bindExecution(
  db: Db,
  session: OwnedSession,
  kernel: { id: string; generation: number } | null,
  input: {
    ref: string;
    cellId: string;
    workingCopyRevision?: number | undefined;
    code: string;
    msgId: string;
  },
  now: Date,
): Promise<BindResult> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(notebookSessions)
      .where(eq(notebookSessions.id, session.id))
      .for('update');
    const existing = await byRef(tx, session.id, input.ref);
    if (existing) return { kind: 'existing' as const, row: existing };
    if (
      !kernel ||
      !current ||
      current.state !== 'ready' ||
      current.kernelId !== kernel.id ||
      current.kernelGeneration !== kernel.generation
    ) {
      return { kind: 'not_ready' as const };
    }
    const [last] = await tx
      .select({ seq: max(cellExecutions.seq) })
      .from(cellExecutions)
      .where(eq(cellExecutions.sessionId, session.id));
    const [row] = await tx
      .insert(cellExecutions)
      .values({
        classId: current.classId,
        sessionId: session.id,
        clientRef: input.ref,
        seq: (last?.seq ?? 0) + 1,
        cellId: input.cellId,
        resourceRevisionId: current.resourceRevisionId,
        workingCopyRevision: input.workingCopyRevision ?? null,
        codeHash: createHash('sha256').update(input.code, 'utf8').digest(),
        kernelId: kernel.id,
        kernelGeneration: kernel.generation,
        msgId: input.msgId,
        state: 'sent',
        sentAt: now,
      })
      .onConflictDoNothing({ target: [cellExecutions.sessionId, cellExecutions.clientRef] })
      .returning();
    if (row) return { kind: 'created' as const, row };
    const raced = await byRef(tx, session.id, input.ref);
    if (!raced) throw new Error('execution insert conflicted without a row');
    return { kind: 'existing' as const, row: raced };
  });
}

async function byRef(tx: Tx, sessionId: string, ref: string): Promise<ExecutionRow | undefined> {
  const [row] = await tx
    .select()
    .from(cellExecutions)
    .where(and(eq(cellExecutions.sessionId, sessionId), eq(cellExecutions.clientRef, ref)));
  return row;
}

const FINAL: readonly ExecutionStateName[] = ['ok', 'error', 'aborted', 'incomplete'];

/**
 * Moves one execution to `state` if it is in one of `from`; null when it was not. A final state
 * records `finishedAt`.
 */
export async function moveExecution(
  db: Db,
  executionId: string,
  from: readonly ExecutionStateName[],
  state: ExecutionStateName,
  now: Date,
  extra: { executionCount?: number | undefined; outputsIncomplete?: boolean } = {},
): Promise<ExecutionRow | null> {
  const [row] = await db
    .update(cellExecutions)
    .set({
      state,
      ...(extra.executionCount !== undefined && { executionCount: extra.executionCount }),
      ...(extra.outputsIncomplete !== undefined && { outputsIncomplete: extra.outputsIncomplete }),
      ...(FINAL.includes(state) && { finishedAt: now }),
    })
    .where(and(eq(cellExecutions.id, executionId), inArray(cellExecutions.state, [...from])))
    .returning();
  return row ?? null;
}

/** The executions of a session the kernel may still answer, in order. */
export function openExecutions(db: Db, sessionId: string): Promise<ExecutionRow[]> {
  return db
    .select()
    .from(cellExecutions)
    .where(
      and(
        eq(cellExecutions.sessionId, sessionId),
        inArray(cellExecutions.state, [...OPEN_EXECUTION_STATES]),
      ),
    )
    .orderBy(asc(cellExecutions.seq));
}

/** Moves every execution of `sessionId` in `from` to `to`; returns the rows moved. */
export function moveSessionExecutions(
  db: Db | Tx,
  sessionId: string,
  from: readonly ExecutionStateName[],
  to: ExecutionStateName,
  now: Date,
  extra: { outputsIncomplete?: boolean } = {},
): Promise<ExecutionRow[]> {
  return db
    .update(cellExecutions)
    .set({
      state: to,
      ...(extra.outputsIncomplete !== undefined && { outputsIncomplete: extra.outputsIncomplete }),
      ...(FINAL.includes(to) && { finishedAt: now }),
    })
    .where(and(eq(cellExecutions.sessionId, sessionId), inArray(cellExecutions.state, [...from])))
    .returning();
}

/**
 * The link to a connector dropped: the in-flight executions of its sessions may or may not have
 * reached their kernel, so they become `unconfirmed` (§10.6).
 */
export function markConnectorExecutionsUnconfirmed(
  db: Db,
  connectorId: string,
): Promise<ExecutionRow[]> {
  return db
    .update(cellExecutions)
    .set({ state: 'unconfirmed' })
    .where(
      and(
        inArray(cellExecutions.state, [...IN_FLIGHT]),
        inArray(
          cellExecutions.sessionId,
          db
            .select({ id: notebookSessions.id })
            .from(notebookSessions)
            .where(eq(notebookSessions.connectorId, connectorId)),
        ),
      ),
    )
    .returning();
}

/**
 * This relay process started: nothing it held survived, so every in-flight execution is
 * `unconfirmed` until its kernel is asked (§10.6, §10.7).
 */
export function markExecutionsUnconfirmedAtStart(db: Db): Promise<ExecutionRow[]> {
  return db
    .update(cellExecutions)
    .set({ state: 'unconfirmed' })
    .where(inArray(cellExecutions.state, [...IN_FLIGHT]))
    .returning();
}

/**
 * Records a new kernel (`kernel`) or none (`null`) on a session: the generation increases, the
 * executions of the kernel it replaces become `aborted`, and a `kernel_lost` cause is cleared.
 */
export function setSessionKernel(
  db: Db,
  sessionId: string,
  kernel: { id: string; name: string } | null,
  now: Date,
): Promise<{ session: SessionRow; aborted: ExecutionRow[] }> {
  return db.transaction(async (tx) => {
    const aborted = await moveSessionExecutions(
      tx,
      sessionId,
      OPEN_EXECUTION_STATES,
      'aborted',
      now,
    );
    const [session] = await tx
      .update(notebookSessions)
      .set({
        kernelId: kernel?.id ?? null,
        ...(kernel && { kernelName: kernel.name }),
        kernelGeneration: sql`${notebookSessions.kernelGeneration} + ${kernel ? 1 : 0}`,
        cause: sql`case when ${notebookSessions.cause} = 'kernel_lost' then null else ${notebookSessions.cause} end`,
      })
      .where(eq(notebookSessions.id, sessionId))
      .returning();
    if (!session) throw new Error('session vanished');
    return { session, aborted };
  });
}

/**
 * Restart (§10.6): the generation increases and every unfinished execution of the kernel becomes
 * `aborted`; nothing is run again. Null when the session is no longer on `kernelId`.
 */
export function restartGeneration(
  db: Db,
  sessionId: string,
  kernelId: string,
  now: Date,
): Promise<{ session: SessionRow; aborted: ExecutionRow[] } | null> {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .update(notebookSessions)
      .set({ kernelGeneration: sql`${notebookSessions.kernelGeneration} + 1` })
      .where(and(eq(notebookSessions.id, sessionId), eq(notebookSessions.kernelId, kernelId)))
      .returning();
    if (!session) return null;
    const aborted = await moveSessionExecutions(
      tx,
      sessionId,
      OPEN_EXECUTION_STATES,
      'aborted',
      now,
    );
    return { session, aborted };
  });
}

/**
 * Jupyter no longer knows the kernel (§10.6, a 404 after reconnect): the session keeps its
 * Jupyter server but loses the kernel (cause `kernel_lost`, shown with a new-kernel offer and
 * the warning that variables are gone), and its unfinished executions become `incomplete`. The
 * session's state is not changed: only the connector's reports move it (§10.7).
 */
export function markKernelLost(
  db: Db,
  sessionId: string,
  kernelId: string,
  now: Date,
): Promise<{ session: SessionRow; incomplete: ExecutionRow[] } | null> {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .update(notebookSessions)
      .set({ kernelId: null, cause: 'kernel_lost' })
      .where(and(eq(notebookSessions.id, sessionId), eq(notebookSessions.kernelId, kernelId)))
      .returning();
    if (!session) return null;
    const incomplete = await moveSessionExecutions(
      tx,
      sessionId,
      OPEN_EXECUTION_STATES,
      'incomplete',
      now,
      { outputsIncomplete: true },
    );
    return { session, incomplete };
  });
}

/** The current row of a session the relay already holds. */
export async function sessionRow(db: Db, sessionId: string): Promise<SessionRow | null> {
  const [row] = await db.select().from(notebookSessions).where(eq(notebookSessions.id, sessionId));
  return row ?? null;
}

/** At most this many executions answer one reconciliation request. */
export const EXECUTIONS_PAGE = 500;

/** The caller's session's executions after `afterSeq`, in order; null for anyone else's session. */
export async function executionsAfter(
  db: Db,
  scope: ClassScope,
  sessionId: string,
  afterSeq: number,
): Promise<ExecutionRow[] | null> {
  const session = await findSession(db, scope, sessionId);
  if (!session) return null;
  return db
    .select()
    .from(cellExecutions)
    .where(and(eq(cellExecutions.sessionId, session.id), gt(cellExecutions.seq, afterSeq)))
    .orderBy(asc(cellExecutions.seq))
    .limit(EXECUTIONS_PAGE);
}

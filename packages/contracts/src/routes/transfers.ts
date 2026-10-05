import { z } from 'zod';
import { classArchived, defineRoute, invalidBody } from '../define';
import { exampleIds } from '../examples';
import { WorkingCopyView } from './workingCopies';

/**
 * Files of a notebook session's workspace (spec §10.5, docs/design/connector.md §11): listing
 * confined to the workspace, copy-in of the files the course notebook declares, Save to computer,
 * Import, and copy-out of selected files into the class's storage. Every remote read and write is
 * a `purpose: 'contents'` request the relay builds itself (§7); the browser never names anything
 * outside the workspace. A file on the computer is never overwritten unasked: a different file
 * already there is a `conflict` until the person chooses. Every route reads only the caller's
 * own sessions; anyone else's is the shared 404 (A33).
 */

/** Largest single file copied out of a workspace (design §11). */
export const MAX_COPY_OUT_FILE_BYTES = 25 * 1024 * 1024;
/** Most bytes copied out of one session in total (design §11). */
export const MAX_COPY_OUT_SESSION_BYTES = 200 * 1024 * 1024;

const datetime = z.iso.datetime({ offset: true });
const sessionParams = z.object({ classId: z.uuid(), sessionId: z.uuid() });
const exampleSession = { classId: exampleIds.zero, sessionId: exampleIds.cc };

/**
 * A path relative to the session's workspace: `/`-separated names, none empty, `.`, `..` or
 * starting with `.`, no backslash or control character, at most 1024 characters. The relay
 * checks it again against the workspace before building a request (§7).
 */
export const WorkspacePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      path
        .split('/')
        .every(
          (seg) =>
            seg !== '' &&
            !seg.startsWith('.') &&
            ![...seg].some((c) => c === '\\' || c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f),
        ),
    { message: 'a workspace path is relative, without empty, dot or hidden segments' },
  );

/** What to do with a file that already differs at the destination (design §11). */
export const ConflictChoice = z.enum(['keep_theirs', 'replace', 'save_copy']);

export const TransferKind = z.enum(['copy_in', 'save', 'import', 'copy_out']);

export const TransferView = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  /** `in`: Parallax → workspace (copy-in, Save to computer); `out`: workspace → Parallax. */
  direction: z.enum(['in', 'out']),
  kind: TransferKind,
  /** Relative to the workspace; for `save_copy`, the name actually written. */
  path: z.string(),
  /** Of the bytes Parallax sent or received; empty when none were. */
  sha256: z.string(),
  size: z.int(),
  /**
   * `done` only once the connector acknowledged the write (in) or Parallax stored the bytes
   * (out); `conflict` wrote nothing and waits for a choice; `failed` names its `error`.
   */
  state: z.enum(['started', 'done', 'failed', 'conflict']),
  /**
   * For a `done` transfer: `copied` (written or stored), `unchanged` (the same file was already
   * there, nothing written), `kept_theirs` (nothing written), `replaced`, `saved_copy`.
   */
  outcome: z.enum(['copied', 'unchanged', 'kept_theirs', 'replaced', 'saved_copy']).nullable(),
  /**
   * The file found at the destination, for a conflict or a resolved one; `sha256` is empty when
   * its size already showed it differs, so it was not read.
   */
  remote: z.object({ sha256: z.string(), size: z.int() }).nullable(),
  /** Why a transfer failed: `too_large`, `session_limit`, `not_found`, `not_a_file`, a code. */
  error: z.string().nullable(),
  /** For an import: the working-copy revision it created. */
  revision: z.int().nullable(),
  createdAt: datetime,
  finishedAt: datetime.nullable(),
});
export type TransferView = z.infer<typeof TransferView>;

/** A file the course notebook declares for the workspace (`metadata.parallax.files`). */
export const DeclaredFile = z.object({ path: z.string(), size: z.int(), sha256: z.string() });

export const WorkspaceEntry = z.object({
  path: z.string(),
  name: z.string(),
  type: z.enum(['file', 'directory', 'notebook']),
  size: z.int().nullable(),
  modified: datetime.nullable(),
});

/**
 * 409 when the workspace cannot be reached now: `not_ready` (the session is not `ready`),
 * `connector_offline`, `workspace_unknown` (an attached session: the server cannot place paths
 * inside that Jupyter server's root), or `transfer_failed` with the catalogue code or Jupyter
 * status the connector answered.
 */
export const transferRefused = z.object({
  error: z.enum(['not_ready', 'connector_offline', 'workspace_unknown', 'transfer_failed']),
  code: z.string().optional(),
});

/**
 * One directory of the session's workspace (`dir` relative to it; the workspace itself by
 * default), never above it, with the absolute workspace and host to show as the destination
 * ("Copy N files to …", "stays on …"), and the files the course notebook declares.
 */
export const listSessionFiles = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/notebook-sessions/:sessionId/files',
  scope: { kind: 'class', role: 'any' },
  summary: 'List a directory of a notebook session’s workspace',
  params: sessionParams,
  query: z.object({ dir: WorkspacePath.optional() }),
  response: z.object({
    workspace: z.string(),
    /** The SSH host, or null for the connector's own computer. */
    host: z.string().nullable(),
    dir: z.string(),
    entries: z.array(WorkspaceEntry),
    declared: z.array(DeclaredFile),
  }),
  errors: { 400: invalidBody, 409: transferRefused },
  examples: { params: exampleSession, query: {} },
});

/**
 * One transfer request. `copy_in` copies every declared file, applying `resolutions` to
 * conflicts found earlier; `save` writes an acknowledged working-copy revision as `.ipynb`;
 * `import` reads an `.ipynb` from the workspace into a new working-copy revision after
 * `baseRevision` (409 `revision_conflict` when stale); `copy_out` stores selected files in the
 * class's storage.
 */
export const TransferRequest = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('copy_in'),
    resolutions: z
      .array(z.strictObject({ path: WorkspacePath, choice: ConflictChoice }))
      .max(100)
      .default([]),
  }),
  z.strictObject({
    kind: z.literal('save'),
    revision: z.int().min(1),
    path: WorkspacePath.refine((p) => p.toLowerCase().endsWith('.ipynb'), {
      message: 'a notebook is saved as .ipynb',
    }),
    choice: ConflictChoice.optional(),
  }),
  z.strictObject({
    kind: z.literal('import'),
    path: WorkspacePath.refine((p) => p.toLowerCase().endsWith('.ipynb'), {
      message: 'only an .ipynb notebook can be imported',
    }),
    baseRevision: z.int().min(1),
  }),
  z.strictObject({ kind: z.literal('copy_out'), paths: z.array(WorkspacePath).min(1).max(50) }),
]);

export const createTransfer = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/notebook-sessions/:sessionId/transfers',
  scope: { kind: 'class', role: 'any' },
  summary: 'Copy files between Parallax and a notebook session’s workspace',
  params: sessionParams,
  body: TransferRequest,
  response: z.object({
    transfers: z.array(TransferView),
    /** After an import: the working copy with its new revision. */
    workingCopy: WorkingCopyView.optional(),
  }),
  errors: {
    400: invalidBody,
    409: z.union([
      transferRefused,
      z.object({ error: z.literal('revision_conflict'), current: WorkingCopyView }),
      classArchived,
    ]),
  },
  examples: { params: exampleSession, body: { kind: 'copy_in' } },
});

/** The session's transfers, newest first (at most 200). */
export const listTransfers = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/notebook-sessions/:sessionId/transfers',
  scope: { kind: 'class', role: 'any' },
  summary: 'List the file transfers of a notebook session',
  params: sessionParams,
  response: z.object({ transfers: z.array(TransferView) }),
  examples: { params: exampleSession },
});

const transferParams = z.object({
  classId: z.uuid(),
  sessionId: z.uuid(),
  transferId: z.uuid(),
});

export const getTransfer = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/notebook-sessions/:sessionId/transfers/:transferId',
  scope: { kind: 'class', role: 'any' },
  summary: 'Read one file transfer of a notebook session',
  params: transferParams,
  response: TransferView,
  examples: { params: { ...exampleSession, transferId: exampleIds.dd } },
});

/**
 * A short-lived link to a copied-out file, served as an attachment from the content origin
 * (ADR-0002). 404 for a transfer that stored nothing.
 */
export const getTransferDownload = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/notebook-sessions/:sessionId/transfers/:transferId/download',
  scope: { kind: 'class', role: 'any' },
  summary: 'A link to download a file copied out of a workspace',
  params: transferParams,
  response: z.object({ url: z.string(), expiresAt: datetime }),
  examples: { params: { ...exampleSession, transferId: exampleIds.dd } },
});

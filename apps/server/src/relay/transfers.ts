import { LinkContentRoot } from '@parallax/contracts';
import type {
  ConflictChoice,
  TransferRequest as TransferRequestSchema,
  TransferView,
  WorkspaceEntry,
} from '@parallax/contracts/routes/transfers';
import {
  MAX_COPY_OUT_FILE_BYTES,
  MAX_COPY_OUT_SESSION_BYTES,
} from '@parallax/contracts/routes/transfers';
import type { WorkingCopyView } from '@parallax/contracts/routes/workingCopies';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { RouteDeps } from '../app';
import type { ClassScope } from '../auth/scope';
import {
  declaredFiles,
  ObjectTooLarge,
  readObject,
  revisionBytes,
  sha256,
  storeNotebook,
  workingCopyView,
} from '../content/workingCopy';
import type { Db } from '../db/client';
import { connectionForSession } from '../db/connectors/connections';
import type { OwnedSession } from '../db/notebooks/sessions';
import {
  copiedOutBytes,
  type FinishedTransfer,
  recordTransfer,
  type TransferDetail,
  type TransferRow,
  transferDetail,
} from '../db/notebooks/transfers';
import {
  appendRevision,
  type DeclaredObject,
  findWorkingCopy,
  type WorkingCopyRow,
} from '../db/notebooks/workingCopies';
import { classTransferPrefix, type Storage } from '../storage/storage';
import {
  type ContentsQuery,
  contents,
  httpMessage,
  inRoot,
  JupyterArgumentError,
  type JupyterRequest,
  MAX_CONTENTS_BODY,
} from './jupyter';
import {
  type Link,
  type LinkRegistry,
  LinkRequestError,
  type LinkStream,
  type LinkTimers,
  LiveLinkRegistry,
  systemTimers,
} from './links';

/**
 * File transfer between Parallax and a notebook session's workspace (spec §10.5,
 * docs/design/connector.md §11). Every remote read and write is a `purpose: 'contents'` request
 * built by `jupyter.ts` from a workspace-relative path, so nothing outside the workspace can be
 * named, and the connector checks each again (§7). The rules:
 *
 * - copy-in sends only the files the course notebook declares, each resolved to an object
 *   released with that notebook: no other course material (answer keys, hidden checks) has a way
 *   onto a learner's computer;
 * - a file already at the destination is compared by SHA-256: the same one is left alone, a
 *   different one is a `conflict` and nothing is written until the person chooses;
 * - a transfer reads `done` only after Jupyter acknowledged the write or Parallax stored the
 *   bytes; copy-out keeps to 25 MiB a file and 200 MiB a session;
 * - an import becomes a new working-copy revision only after the revision it was based on,
 *   and only as a valid nbformat 4 notebook.
 *
 * Transfers of one session run one after another, so the 200 MiB budget is checked against
 * what is stored, not raced. The relay is one process (§10.1).
 */

/** §4.5: a `contents` exchange has 120 s in all. */
const CONTENTS_TIMEOUT_MS = 120_000;
/** A Jupyter answer carrying a base64 file of up to 64 MiB, with its JSON model around it. */
const MAX_CONTENTS_ANSWER = Math.ceil((MAX_CONTENTS_BODY * 4) / 3) + 64 * 1024;
/** The largest declared file or notebook sent to a workspace: its base64 fits the body limit. */
const MAX_COPY_IN_BYTES = 25 * 1024 * 1024;

type TransferRequest = z.infer<typeof TransferRequestSchema>;

/**
 * `contents` calls named by workspace-relative paths, as the routes and the declared files name
 * them; Jupyter names them below the session's content root (§7).
 */
const inWorkspace = {
  list: (root: string, dir: string) => contents.list(root, inRoot(root, dir)),
  get: (root: string, path: string, q?: ContentsQuery) => contents.get(root, inRoot(root, path), q),
  put: (root: string, path: string, model: object) => contents.put(root, inRoot(root, path), model),
};

export type Refusal =
  | {
      ok: false;
      reason: 'not_ready' | 'connector_offline' | 'workspace_unknown' | 'transfer_failed';
      code?: string;
    }
  | { ok: false; reason: 'invalid'; message: string }
  | { ok: false; reason: 'class_archived' }
  | { ok: false; reason: 'revision_conflict'; current: WorkingCopyView };

interface Answer {
  status: number;
  body: Buffer;
}

/** A Jupyter contents model, as far as transfers read it. */
interface ContentsModel {
  name?: unknown;
  path?: unknown;
  type?: unknown;
  size?: unknown;
  last_modified?: unknown;
  format?: unknown;
  content?: unknown;
}

const json = (body: Buffer): ContentsModel | undefined => {
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as ContentsModel)
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The session's content root: the one its connector reported, checked again with the rules of
 * §7; or empty for a session the connector started in the workspace before roots were reported.
 */
export function contentRoot(session: Pick<OwnedSession, 'runtime' | 'owned'>): string | undefined {
  const runtime = session.runtime as { mode?: unknown; contentRoot?: unknown };
  if (runtime.contentRoot !== undefined) {
    const parsed = LinkContentRoot.safeParse(runtime.contentRoot);
    return parsed.success ? parsed.data : undefined;
  }
  return runtime.mode === 'start' && session.owned ? '' : undefined;
}

/** `name (parallax).ext`: where *save mine as a copy* writes (design §11). */
export function copyName(path: string): string {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0
    ? `${dir}${name.slice(0, dot)} (parallax)${name.slice(dot)}`
    : `${dir}${name} (parallax)`;
}

/** A transfer row as the routes answer it. */
export function transferView(row: TransferRow): TransferView {
  const detail = transferDetail(row);
  return {
    id: row.id,
    sessionId: row.sessionId,
    direction: row.direction,
    kind: detail.kind,
    path: row.path,
    sha256: row.sha256,
    size: row.size,
    state: row.state,
    outcome: detail.outcome ?? null,
    remote: detail.remote ?? null,
    error: detail.error ?? null,
    revision: detail.revision ?? null,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

class TransferFailed extends Error {
  constructor(
    readonly reason: 'connector_offline' | 'transfer_failed',
    readonly code?: string,
  ) {
    super(code ?? reason);
  }
}

/** The bytes of a file model Jupyter answered, in whichever format it chose. */
function modelBytes(model: ContentsModel): Buffer | undefined {
  if (typeof model.content !== 'string') return undefined;
  return model.format === 'base64'
    ? Buffer.from(model.content, 'base64')
    : Buffer.from(model.content, 'utf8');
}

export class TransferRelay {
  /** Per-session chains: one transfer request of a session at a time. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly options: {
      db: Db;
      storage: Storage;
      links: LinkRegistry;
      timers: LinkTimers;
      now: () => Date;
      log: FastifyBaseLogger;
    },
  ) {}

  private get db() {
    return this.options.db;
  }

  private serial<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(sessionId) ?? Promise.resolve()).then(task, task);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(sessionId, settled);
    void settled.then(() => {
      if (this.chains.get(sessionId) === settled) this.chains.delete(sessionId);
    });
    return next;
  }

  /**
   * The link and content root a transfer of `session` uses, or why there is none. The content
   * root is the workspace relative to Jupyter's root, as the connector reported it with `ready`
   * (P3-09b): empty for a session the connector started there, the workspace's place inside the
   * server's `root_dir` for an attached one (§7). A session whose connector reported no usable
   * root (an older connector attached to a server) cannot place its workspace, and transfers are
   * refused (`workspace_unknown`).
   */
  private reach(session: OwnedSession): { link: Link; root: string } | Refusal {
    if (session.state !== 'ready') return { ok: false, reason: 'not_ready' };
    const root = contentRoot(session);
    if (root === undefined) return { ok: false, reason: 'workspace_unknown' };
    const link = this.options.links.get(session.connectorId);
    if (!link) return { ok: false, reason: 'connector_offline' };
    return { link, root };
  }

  /** One `contents` exchange; throws `TransferFailed` when it cannot complete. */
  private call(link: Link, sessionId: string, request: JupyterRequest): Promise<Answer> {
    return new Promise((resolve, reject) => {
      let status = 0;
      let size = 0;
      const chunks: Buffer[] = [];
      let done = false;
      let cancel: () => void = () => {};
      const finish = (result: Answer | TransferFailed) => {
        if (done) return;
        done = true;
        cancel();
        if (result instanceof TransferFailed) reject(result);
        else resolve(result);
      };
      let stream: LinkStream;
      try {
        stream = link.openStream(sessionId, (id) => httpMessage(request, id, sessionId), {
          onControl: (message) => {
            if (message.t === 'http_head') status = message.status;
          },
          onData: (payload) => {
            size += payload.length;
            if (size > MAX_CONTENTS_ANSWER) {
              stream.reset('limit_exceeded', 'contents answer too large');
              finish(new TransferFailed('transfer_failed', 'limit_exceeded'));
              return;
            }
            chunks.push(payload);
            stream.grant(payload.length);
          },
          onClose: ({ code }) => {
            if (code === 'done' && status > 0) {
              finish({ status, body: Buffer.concat(chunks) });
            } else if (code === 'connector_offline') {
              finish(new TransferFailed('connector_offline'));
            } else {
              finish(new TransferFailed('transfer_failed', code));
            }
          },
        });
      } catch (err) {
        const code = err instanceof LinkRequestError ? err.code : 'internal';
        finish(
          code === 'connector_offline'
            ? new TransferFailed('connector_offline')
            : new TransferFailed('transfer_failed', code),
        );
        return;
      }
      cancel = this.options.timers.after(CONTENTS_TIMEOUT_MS, () => {
        stream.reset('stream_cancelled', 'request deadline');
        finish(new TransferFailed('transfer_failed', 'test_timeout'));
      });
      if (request.body) stream.write(request.body, { end: true }).catch(() => undefined);
    });
  }

  /** Runs `task`, answering a refusal for a link that failed underneath it. */
  private async guarded<T>(task: () => Promise<T>): Promise<T | Refusal> {
    try {
      return await task();
    } catch (err) {
      if (err instanceof TransferFailed) {
        return { ok: false, reason: err.reason, ...(err.code && { code: err.code }) };
      }
      if (err instanceof JupyterArgumentError) {
        return { ok: false, reason: 'invalid', message: err.message };
      }
      throw err;
    }
  }

  /** The remote file at `path`: its bytes, or null when there is none. */
  private async remoteFile(
    link: Link,
    session: OwnedSession,
    root: string,
    path: string,
    format: 'base64' | 'text',
  ): Promise<{ bytes: Buffer } | { missing: true } | { error: string }> {
    const answer = await this.call(
      link,
      session.id,
      inWorkspace.get(root, path, { content: 1, type: 'file', format }),
    );
    if (answer.status === 404) return { missing: true };
    if (answer.status !== 200) {
      return { error: answer.status === 400 ? 'not_a_file' : `jupyter_${answer.status}` };
    }
    const model = json(answer.body);
    const bytes = model && modelBytes(model);
    return bytes ? { bytes } : { error: 'not_a_file' };
  }

  /** Writes `bytes` at `path`, making its parent directories; true once Jupyter acknowledged. */
  private async write(
    link: Link,
    session: OwnedSession,
    root: string,
    path: string,
    bytes: Buffer,
    format: 'base64' | 'text',
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      const made = await this.call(
        link,
        session.id,
        inWorkspace.put(root, dir, { type: 'directory' }),
      );
      if (made.status !== 200 && made.status !== 201) {
        return { ok: false, error: `jupyter_${made.status}` };
      }
    }
    const content = format === 'base64' ? bytes.toString('base64') : bytes.toString('utf8');
    const answer = await this.call(
      link,
      session.id,
      inWorkspace.put(root, path, { type: 'file', format, content }),
    );
    return answer.status === 200 || answer.status === 201
      ? { ok: true }
      : { ok: false, error: `jupyter_${answer.status}` };
  }

  private record(
    scope: ClassScope,
    session: OwnedSession,
    input: FinishedTransfer,
    started: Date,
  ): Promise<TransferRow> {
    return recordTransfer(this.db, scope, session, input, started, this.options.now());
  }

  /**
   * Sends `bytes` to `path` by the rules of design §11: absent → written; the same SHA-256 →
   * left alone; different → `conflict` unless `choice` says keep theirs, replace, or save as
   * `name (parallax).ext` (itself never overwriting a different file).
   */
  private async sendFile(
    scope: ClassScope,
    session: OwnedSession,
    reach: { link: Link; root: string },
    file: { path: string; bytes: Buffer; kind: 'copy_in' | 'save'; format: 'base64' | 'text' },
    choice: z.infer<typeof ConflictChoice> | undefined,
  ): Promise<TransferRow> {
    const started = this.options.now();
    const { link, root } = reach;
    const sent = { sha256: sha256(file.bytes), size: file.bytes.length };
    const base = { direction: 'in' as const, ...sent };
    const fail = (path: string, error: string, extra: Partial<TransferDetail> = {}) =>
      this.record(
        scope,
        session,
        { ...base, path, state: 'failed', detail: { kind: file.kind, error, ...extra } },
        started,
      );
    const done = (
      path: string,
      outcome: TransferDetail['outcome'],
      extra: Partial<TransferDetail>,
    ) =>
      this.record(
        scope,
        session,
        { ...base, path, state: 'done', detail: { kind: file.kind, outcome, ...extra } },
        started,
      );
    const writeTo = async (path: string, outcome: TransferDetail['outcome'], extra = {}) => {
      const written = await this.write(link, session, root, path, file.bytes, file.format);
      return written.ok ? done(path, outcome, extra) : fail(path, written.error, extra);
    };

    // The size first: a file of another size differs, and is not read at all.
    const head = await this.call(
      link,
      session.id,
      inWorkspace.get(root, file.path, { content: 0 }),
    );
    let remote: { sha256: string; size: number };
    if (head.status === 404) return writeTo(file.path, 'copied');
    const model = head.status === 200 ? json(head.body) : undefined;
    if (!model || model.type === 'directory') {
      return fail(file.path, model ? 'not_a_file' : `jupyter_${head.status}`);
    }
    if (typeof model.size === 'number' && model.size !== sent.size) {
      remote = { sha256: '', size: model.size };
    } else {
      const there = await this.remoteFile(link, session, root, file.path, file.format);
      if ('error' in there) return fail(file.path, there.error);
      if ('missing' in there) return writeTo(file.path, 'copied');
      remote = { sha256: sha256(there.bytes), size: there.bytes.length };
      if (remote.sha256 === sent.sha256) return done(file.path, 'unchanged', { remote });
    }
    switch (choice) {
      case 'keep_theirs':
        return done(file.path, 'kept_theirs', { remote });
      case 'replace':
        return writeTo(file.path, 'replaced', { remote });
      case 'save_copy': {
        const copy = copyName(file.path);
        const atCopy = await this.remoteFile(link, session, root, copy, file.format);
        if ('error' in atCopy) return fail(copy, atCopy.error, { remote });
        if ('missing' in atCopy) return writeTo(copy, 'saved_copy', { remote });
        // Another file already holds the copy's name: never overwritten unasked either.
        return sha256(atCopy.bytes) === sent.sha256
          ? done(copy, 'saved_copy', { remote })
          : fail(copy, 'copy_exists', { remote });
      }
      default:
        return this.record(
          scope,
          session,
          { ...base, path: file.path, state: 'conflict', detail: { kind: file.kind, remote } },
          started,
        );
    }
  }

  private async workingCopyOf(scope: ClassScope, session: OwnedSession) {
    return findWorkingCopy(this.db, scope, session.resourceRevisionId);
  }

  /** Lists one directory of the workspace, with the destination to show and the declared files. */
  async files(
    scope: ClassScope,
    session: OwnedSession,
    dir: string | undefined,
  ): Promise<
    | {
        ok: true;
        workspace: string;
        host: string | null;
        dir: string;
        entries: z.infer<typeof WorkspaceEntry>[];
        declared: DeclaredObject[];
      }
    | Refusal
  > {
    const reach = this.reach(session);
    if ('ok' in reach) return reach;
    const found = await connectionForSession(this.db, scope, session.connectionId);
    if (!found) return { ok: false, reason: 'not_ready' };
    const target = found.connection.target;
    const copy = await this.workingCopyOf(scope, session);
    const declared = copy ? await declaredFiles(this.db, this.options.storage, scope, copy) : [];
    return this.guarded(async () => {
      const path = dir ?? '';
      const answer = await this.call(reach.link, session.id, inWorkspace.list(reach.root, path));
      if (answer.status === 404) {
        return { ok: false as const, reason: 'invalid' as const, message: 'No such folder' };
      }
      if (answer.status !== 200) {
        return {
          ok: false as const,
          reason: 'transfer_failed' as const,
          code: `jupyter_${answer.status}`,
        };
      }
      const listed = json(answer.body)?.content;
      type Entry = z.infer<typeof WorkspaceEntry>;
      const entries = (Array.isArray(listed) ? (listed as ContentsModel[]) : []).flatMap(
        (m): Entry[] => {
          const name = typeof m.name === 'string' ? m.name : '';
          const type = m.type;
          // Hidden names cannot be requested (§7), so they are not offered either.
          if (!name || name.startsWith('.') || name.includes('/')) return [];
          if (type !== 'file' && type !== 'directory' && type !== 'notebook') return [];
          const modified =
            typeof m.last_modified === 'string' && !Number.isNaN(Date.parse(m.last_modified))
              ? new Date(m.last_modified).toISOString()
              : null;
          return [
            {
              path: path === '' ? name : `${path}/${name}`,
              name,
              type,
              size: typeof m.size === 'number' && Number.isInteger(m.size) ? m.size : null,
              modified,
            },
          ];
        },
      );
      return {
        ok: true as const,
        workspace: target.workspace,
        host: target.kind === 'ssh' ? target.host : null,
        dir: path,
        entries,
        declared,
      };
    });
  }

  /** Carries out one transfer request; the answer lists the transfers it recorded. */
  transfer(
    scope: ClassScope,
    session: OwnedSession,
    request: TransferRequest,
  ): Promise<{ ok: true; transfers: TransferRow[]; workingCopy?: WorkingCopyView } | Refusal> {
    if (scope.archived) return Promise.resolve({ ok: false, reason: 'class_archived' });
    const reach = this.reach(session);
    if ('ok' in reach) return Promise.resolve(reach);
    return this.serial(session.id, () =>
      this.guarded(async () => {
        const copy = await this.workingCopyOf(scope, session);
        switch (request.kind) {
          case 'copy_in':
            return this.copyIn(scope, session, reach, copy, request.resolutions);
          case 'save':
            return this.save(scope, session, reach, copy, request);
          case 'import':
            return this.import(scope, session, reach, copy, request);
          case 'copy_out':
            return this.copyOut(scope, session, reach, request.paths);
        }
      }),
    );
  }

  private async copyIn(
    scope: ClassScope,
    session: OwnedSession,
    reach: { link: Link; root: string },
    copy: WorkingCopyRow | null,
    resolutions: { path: string; choice: z.infer<typeof ConflictChoice> }[],
  ) {
    const declared = copy ? await declaredFiles(this.db, this.options.storage, scope, copy) : [];
    const transfers: TransferRow[] = [];
    for (const file of declared) {
      let bytes: Buffer;
      try {
        bytes = await readObject(this.options.storage, file.key, MAX_COPY_IN_BYTES);
      } catch (err) {
        if (!(err instanceof ObjectTooLarge)) throw err;
        transfers.push(
          await this.record(
            scope,
            session,
            {
              direction: 'in',
              path: file.path,
              sha256: file.sha256,
              size: file.size,
              state: 'failed',
              detail: { kind: 'copy_in', error: 'too_large' },
            },
            this.options.now(),
          ),
        );
        continue;
      }
      const choice = resolutions.find((r) => r.path === file.path)?.choice;
      transfers.push(
        await this.sendFile(
          scope,
          session,
          reach,
          { path: file.path, bytes, kind: 'copy_in', format: 'base64' },
          choice,
        ),
      );
    }
    return { ok: true as const, transfers };
  }

  private async save(
    scope: ClassScope,
    session: OwnedSession,
    reach: { link: Link; root: string },
    copy: WorkingCopyRow | null,
    request: {
      revision: number;
      path: string;
      choice?: z.infer<typeof ConflictChoice> | undefined;
    },
  ) {
    const found =
      copy && (await revisionBytes(this.db, this.options.storage, scope, copy, request.revision));
    if (!found) {
      return {
        ok: false as const,
        reason: 'invalid' as const,
        message: 'That revision does not exist',
      };
    }
    const row = await this.sendFile(
      scope,
      session,
      reach,
      { path: request.path, bytes: found.bytes, kind: 'save', format: 'text' },
      request.choice,
    );
    return { ok: true as const, transfers: [row] };
  }

  private async import(
    scope: ClassScope,
    session: OwnedSession,
    reach: { link: Link; root: string },
    copy: WorkingCopyRow | null,
    request: { path: string; baseRevision: number },
  ) {
    if (!copy) {
      return {
        ok: false as const,
        reason: 'invalid' as const,
        message: 'This notebook has no working copy',
      };
    }
    const started = this.options.now();
    const there = await this.remoteFile(reach.link, session, reach.root, request.path, 'text');
    if (!('bytes' in there)) {
      const error = 'missing' in there ? 'not_found' : there.error;
      const row = await this.record(
        scope,
        session,
        {
          direction: 'out',
          path: request.path,
          sha256: '',
          size: 0,
          state: 'failed',
          detail: { kind: 'import', error },
        },
        started,
      );
      return { ok: true as const, transfers: [row] };
    }
    const stored = await storeNotebook(this.options.storage, scope, there.bytes.toString('utf8'));
    if (!stored.ok)
      return { ok: false as const, reason: 'invalid' as const, message: stored.error };
    const appended = await appendRevision(
      this.db,
      scope,
      copy.id,
      { baseRevision: request.baseRevision, stored: stored.stored, source: 'import' },
      this.options.now(),
    );
    if (!appended.ok) {
      if (appended.reason === 'revision_conflict') {
        const current = await workingCopyView(
          this.db,
          this.options.storage,
          scope,
          appended.workingCopy,
        );
        if (!current) throw new Error('the current working-copy revision is missing');
        return { ok: false as const, reason: 'revision_conflict' as const, current };
      }
      if (appended.reason === 'class_archived')
        return { ok: false as const, reason: 'class_archived' as const };
      return {
        ok: false as const,
        reason: 'invalid' as const,
        message: 'This notebook has no working copy',
      };
    }
    const row = await this.record(
      scope,
      session,
      {
        direction: 'out',
        path: request.path,
        sha256: sha256(there.bytes),
        size: there.bytes.length,
        state: 'done',
        detail: { kind: 'import', outcome: 'copied', revision: appended.revision.revision },
      },
      started,
    );
    const workingCopy = await workingCopyView(
      this.db,
      this.options.storage,
      scope,
      appended.workingCopy,
    );
    return { ok: true as const, transfers: [row], ...(workingCopy && { workingCopy }) };
  }

  private async copyOut(
    scope: ClassScope,
    session: OwnedSession,
    reach: { link: Link; root: string },
    paths: string[],
  ) {
    const transfers: TransferRow[] = [];
    let used = await copiedOutBytes(this.db, scope, session);
    for (const path of new Set(paths)) {
      const started = this.options.now();
      const failed = (error: string, size = 0) =>
        this.record(
          scope,
          session,
          {
            direction: 'out',
            path,
            sha256: '',
            size,
            state: 'failed',
            detail: { kind: 'copy_out', error },
          },
          started,
        );
      // The size first, so a file over a limit is never read.
      const head = await this.call(
        reach.link,
        session.id,
        inWorkspace.get(reach.root, path, { content: 0 }),
      );
      const model = head.status === 200 ? json(head.body) : undefined;
      if (head.status === 404) {
        transfers.push(await failed('not_found'));
        continue;
      }
      if (!model) {
        transfers.push(await failed(`jupyter_${head.status}`));
        continue;
      }
      if (model.type === 'directory') {
        transfers.push(await failed('not_a_file'));
        continue;
      }
      const declaredSize = typeof model.size === 'number' ? model.size : 0;
      if (declaredSize > MAX_COPY_OUT_FILE_BYTES) {
        transfers.push(await failed('too_large', declaredSize));
        continue;
      }
      if (used + declaredSize > MAX_COPY_OUT_SESSION_BYTES) {
        transfers.push(await failed('session_limit', declaredSize));
        continue;
      }
      const there = await this.remoteFile(reach.link, session, reach.root, path, 'base64');
      if (!('bytes' in there)) {
        transfers.push(await failed('missing' in there ? 'not_found' : there.error));
        continue;
      }
      // The file may have grown since it was listed: the limits hold for what was received.
      if (there.bytes.length > MAX_COPY_OUT_FILE_BYTES) {
        transfers.push(await failed('too_large', there.bytes.length));
        continue;
      }
      if (used + there.bytes.length > MAX_COPY_OUT_SESSION_BYTES) {
        transfers.push(await failed('session_limit', there.bytes.length));
        continue;
      }
      const stored = await this.options.storage.put(
        classTransferPrefix(scope.classId),
        there.bytes,
      );
      used += stored.size;
      transfers.push(
        await this.record(
          scope,
          session,
          {
            direction: 'out',
            path,
            sha256: stored.sha256,
            size: stored.size,
            state: 'done',
            objectKey: stored.key,
            detail: { kind: 'copy_out', outcome: 'copied' },
          },
          started,
        ),
      );
    }
    return { ok: true as const, transfers };
  }
}

const relays = new WeakMap<RouteDeps['links'], TransferRelay>();

/** The transfer relay of this app (one per live-link registry); undefined without a database. */
export function transferRelay(app: FastifyInstance, deps: RouteDeps): TransferRelay | undefined {
  if (!deps.db) return undefined;
  const known = relays.get(deps.links);
  if (known) return known;
  const relay = new TransferRelay({
    db: deps.db,
    storage: deps.storage,
    links: deps.links,
    timers: deps.links instanceof LiveLinkRegistry ? deps.links.timers : systemTimers,
    now: deps.now,
    log: app.log.child({ component: 'transfers' }),
  });
  relays.set(deps.links, relay);
  return relay;
}

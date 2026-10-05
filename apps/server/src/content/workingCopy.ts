import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { parseNotebook } from '@parallax/contracts';
import { WorkspacePath } from '@parallax/contracts/routes/transfers';
import {
  MAX_WORKING_COPY_BYTES,
  type WorkingCopyView,
} from '@parallax/contracts/routes/workingCopies';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { ClassScope } from '../auth/scope';
import type { Db } from '../db/client';
import {
  createWorkingCopy,
  type DeclaredObject,
  declaredObjects,
  findWorkingCopy,
  linkSessionWorkingCopy,
  studyableNotebook,
  type WorkingCopyRevisionRow,
  type WorkingCopyRow,
  workingCopyRevision,
  workingCopyRevisions,
} from '../db/notebooks/workingCopies';
import { classWorkingCopyPrefix, type Storage, type StoredObject } from '../storage/storage';

/**
 * Working copies in storage (spec §10.5, docs/design/connector.md §11): the first Connect copies
 * the course notebook into the class's area as revision 1; later revisions are what the browser
 * saved or an import read, each a validated nbformat 4 notebook. Only the notebook document is
 * stored: kernel memory never reaches Parallax.
 */

export const NOTEBOOK_TYPE = 'application/x-ipynb+json';

/** The bytes were larger than the limit given to `readObject`. */
export class ObjectTooLarge extends Error {}

/** Reads a whole stored object, refusing one over `max` bytes. */
export async function readObject(storage: Storage, key: string, max: number): Promise<Buffer> {
  const { body, size } = await storage.get(key);
  if (size > max) {
    body.destroy();
    throw new ObjectTooLarge(`${key} is ${size} bytes`);
  }
  return collect(body, max);
}

async function collect(body: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > max) {
      body.destroy();
      throw new ObjectTooLarge('the object grew past its limit');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** The `.ipynb` text Parallax stores for a notebook: Jupyter's own layout. */
export const notebookText = (notebook: unknown) => `${JSON.stringify(notebook, null, 1)}\n`;

/** Parses `text` as nbformat 4 and stores it in the class's working-copy area. */
export async function storeNotebook(
  storage: Storage,
  scope: ClassScope,
  text: string,
): Promise<{ ok: true; stored: StoredObject } | { ok: false; error: string; tooLarge?: true }> {
  const parsed = parseNotebook(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const bytes = Buffer.from(notebookText(parsed.notebook), 'utf8');
  if (bytes.length > MAX_WORKING_COPY_BYTES) {
    return { ok: false, error: 'The notebook is larger than 25 MB', tooLarge: true };
  }
  return { ok: true, stored: await storage.put(classWorkingCopyPrefix(scope.classId), bytes) };
}

/**
 * First Connect (design §11): makes the caller's working copy of the course notebook revision
 * unless it exists, and ties the session to it. A notebook without an uploaded `.ipynb` among its
 * objects, or one that is not valid nbformat, gets no working copy (logged); Connect itself goes
 * on, as the kernel needs no document.
 */
export async function ensureWorkingCopy(
  db: Db,
  storage: Storage,
  scope: ClassScope,
  input: { revisionId: string; sessionId: string },
  now: Date,
  log: FastifyBaseLogger,
): Promise<WorkingCopyRow | null> {
  let copy = await findWorkingCopy(db, scope, input.revisionId);
  if (!copy) {
    const source = await studyableNotebook(db, scope, input.revisionId, now);
    if (!source?.sourceKey) {
      log.warn({ revisionId: input.revisionId }, 'notebook has no stored source; no working copy');
      return null;
    }
    const bytes = await readObject(storage, source.sourceKey, MAX_WORKING_COPY_BYTES);
    const stored = await storeNotebook(storage, scope, bytes.toString('utf8'));
    if (!stored.ok) {
      log.warn({ revisionId: input.revisionId, error: stored.error }, 'course notebook unusable');
      return null;
    }
    copy = await createWorkingCopy(db, scope, input.revisionId, stored.stored, now);
  }
  await linkSessionWorkingCopy(db, scope, input.sessionId, copy);
  return copy;
}

const revisionView = (row: WorkingCopyRevisionRow) => ({
  revision: row.revision,
  sha256: row.sha256,
  size: row.size,
  source: row.source,
  savedAt: row.createdAt.toISOString(),
});

/** The working copy with one revision's notebook (the current one by default); null if absent. */
export async function workingCopyView(
  db: Db,
  storage: Storage,
  scope: ClassScope,
  copy: WorkingCopyRow,
  revision: number = copy.currentRevision,
): Promise<WorkingCopyView | null> {
  const row = await workingCopyRevision(db, scope, copy, revision);
  if (!row) return null;
  const bytes = await readObject(storage, row.objectKey, MAX_WORKING_COPY_BYTES);
  return {
    id: copy.id,
    sourceRevisionId: copy.sourceRevisionId,
    currentRevision: copy.currentRevision,
    revision: revisionView(row),
    notebook: JSON.parse(bytes.toString('utf8')) as Record<string, unknown>,
    revisions: (await workingCopyRevisions(db, scope, copy)).map(revisionView),
  };
}

/** The bytes of one acknowledged revision; null when it does not exist. */
export async function revisionBytes(
  db: Db,
  storage: Storage,
  scope: ClassScope,
  copy: WorkingCopyRow,
  revision: number,
): Promise<{ row: WorkingCopyRevisionRow; bytes: Buffer } | null> {
  const row = await workingCopyRevision(db, scope, copy, revision);
  if (!row) return null;
  return { row, bytes: await readObject(storage, row.objectKey, MAX_WORKING_COPY_BYTES) };
}

/** At most this many declared files are read from a notebook. */
const MAX_DECLARED = 100;

const DeclaredEntry = z.object({ path: WorkspacePath, resourceId: z.uuid() });

/**
 * The files the course notebook declares for the workspace, from its own metadata
 * (`metadata.parallax.files: [{ path, resourceId }]`, read from revision 1, the course notebook):
 * never the person's edits, so a working copy cannot name other course material. Malformed or
 * duplicate entries are skipped; each kept one names an object released with the notebook.
 */
export async function declaredFiles(
  db: Db,
  storage: Storage,
  scope: ClassScope,
  copy: WorkingCopyRow,
): Promise<DeclaredObject[]> {
  const first = await revisionBytes(db, storage, scope, copy, 1);
  if (!first) return [];
  let files: unknown;
  try {
    const notebook = JSON.parse(first.bytes.toString('utf8')) as {
      metadata?: { parallax?: { files?: unknown } };
    };
    files = notebook.metadata?.parallax?.files;
  } catch {
    return [];
  }
  if (!Array.isArray(files)) return [];
  const seen = new Set<string>();
  const entries: { path: string; resourceId: string }[] = [];
  for (const raw of files.slice(0, MAX_DECLARED)) {
    const entry = DeclaredEntry.safeParse(raw);
    if (!entry.success || seen.has(entry.data.path)) continue;
    seen.add(entry.data.path);
    entries.push(entry.data);
  }
  return declaredObjects(db, scope, copy.sourceRevisionId, entries);
}

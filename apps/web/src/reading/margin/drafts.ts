import type { Anchor } from '@parallax/contracts';

/**
 * Unsent text in the reading margin, kept on this device (§8): a note whose last edit the server
 * has not acknowledged, and a question not yet posted. A successful write here is *not* a server
 * acknowledgement; it only means the text survives a reload, a lost connection or a tab change.
 * Records carry the user, so another account on the same browser never sees them, and sign-out
 * removes them all.
 */
export interface Draft {
  /** `user|class|resource|id`: the record's own key. */
  key: string;
  userId: string;
  classId: string;
  resourceId: string;
  kind: 'note' | 'ask';
  /** The annotation being edited, or null for a note not yet created or a question. */
  annotationId: string | null;
  /** The revision the edit was made against (send as `expectedRevision`). */
  expectedRevision: number | null;
  anchor: Anchor;
  body: string;
  audience: 'instructor' | 'class' | null;
  updatedAt: number;
}

const DB = 'parallax-drafts';
const STORE = 'drafts';

export const draftKey = (userId: string, classId: string, resourceId: string, id: string) =>
  `${userId}|${classId}|${resourceId}|${id}`;

/**
 * Sends of unsent text that are still running in this tab, by draft key. A margin that went away
 * keeps sending (§8), and the draft stays on the device until the server answers; a margin that
 * comes back must not read that draft as unsent and send it a second time.
 */
const sending = new Set<{ key: string; done: Promise<void> }>();

/** Marks the draft `key` as being sent; call the returned function once the send has finished. */
export function beginSend(key: string): () => void {
  let release = () => {};
  const entry = { key, done: new Promise<void>((resolve) => (release = resolve)) };
  sending.add(entry);
  return () => {
    sending.delete(entry);
    release();
  };
}

/**
 * Runs a device write of draft `key` as a pending write: `sendsSettled` waits on it, so a margin
 * that comes back before it commits cannot read the draft as it stood (a deleted note or a cleared
 * question restored as unsent). Writes register themselves; callers need not await them.
 */
async function pending<T>(key: string, write: () => Promise<T>): Promise<T> {
  const done = beginSend(key);
  try {
    return await write();
  } finally {
    done();
  }
}

/**
 * Test seam: while set, `removeDraft` waits for it before touching the store (after registering
 * itself as pending). Use `holdDraftDeletes` from `test/draftHold.ts`; production code never sets it.
 */
export const draftWriteHold: { deletes: Promise<void> | null } = { deletes: null };

/** Resolves once no send of this person's drafts for this resource is running any more. */
export async function sendsSettled(
  userId: string,
  classId: string,
  resourceId: string,
): Promise<void> {
  const prefix = `${userId}|${classId}|${resourceId}|`;
  for (;;) {
    const running = [...sending].filter((s) => s.key.startsWith(prefix));
    if (running.length === 0) return;
    await Promise.all(running.map((s) => s.done));
  }
}

/** What this tab holds right now; reads are answered from here, writes go through to IndexedDB. */
const memory = new Map<string, Draft>();
let opened: Promise<IDBDatabase | null> | null = null;

function database(): Promise<IDBDatabase | null> {
  opened ??= new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    try {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      // Private windows and blocked site data: drafts then live in this tab only.
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opened;
}

function run<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return database().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const request = work(db.transaction(STORE, mode).objectStore(STORE));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

/**
 * People who signed out on this device. The durable record is a marker in the same store, so a
 * save still in flight in *another* tab (its reading unmounting as the session ends) is refused
 * too; this set only answers quickly for what this tab already knows.
 */
const signedOut = new Set<string>();

/** Key of the marker that says `userId` signed out on this device. */
export const signedOutKey = (userId: string) => `signed-out|${userId}`;

const CHANNEL = 'parallax-drafts';
let listening = false;

/** Other tabs hear a sign-out at once and forget the person's drafts held in their memory. */
function listen() {
  if (listening || typeof BroadcastChannel === 'undefined') return;
  listening = true;
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent<{ signedOut?: string }>) => {
    if (event.data?.signedOut) forget(event.data.signedOut);
  };
  // Node's channel (tests) would otherwise keep the process alive.
  (channel as { unref?: () => void }).unref?.();
}

function forget(userId: string) {
  signedOut.add(userId);
  for (const [key, copy] of copies) if (copy.userId === userId) copies.delete(key);
  for (const [key, draft] of memory) if (draft.userId === userId) memory.delete(key);
}

/** A person is using this device again; their drafts are kept from now on. */
export async function allowDrafts(userId: string): Promise<void> {
  signedOut.delete(userId);
  await run('readwrite', (store) => store.delete(signedOutKey(userId)));
}

/**
 * Writes the draft; resolves true once the browser's store holds it (false: this tab only, or
 * refused because the person signed out). The sign-out marker is read in the same transaction.
 */
export async function saveDraft(draft: Draft): Promise<boolean> {
  listen();
  if (signedOut.has(draft.userId)) return false;
  memory.set(draft.key, draft);
  return pending(draft.key, () => put(draft));
}

async function put(record: { key: string; userId: string }): Promise<boolean> {
  listen();
  if (signedOut.has(record.userId)) return false;
  const db = await database();
  if (!db) return false;
  const outcome = await new Promise<'stored' | 'refused' | 'failed'>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const marker = store.get(signedOutKey(record.userId));
      marker.onsuccess = () => {
        if (marker.result) resolve('refused');
        else store.put(record);
      };
      tx.oncomplete = () => resolve('stored');
      tx.onerror = () => resolve('failed');
      tx.onabort = () => resolve('failed');
    } catch {
      resolve('failed');
    }
  });
  if (outcome === 'refused') forget(record.userId);
  return outcome === 'stored';
}

/**
 * Unsent test answers of a closed attempt, kept on this device for an instructor recovery
 * request (§11). Bound to the person, class and attempt; the server accepts a copy only for the
 * caller's own attempt, so a copy found under another key is never offered.
 */
export interface AttemptCopy {
  key: string;
  userId: string;
  kind: 'attempt-copy';
  classId: string;
  attemptId: string;
  answers: { questionId: string; value: unknown }[];
  updatedAt: number;
}

/** localStorage prefix of a test attempt's unsent answers; sign-out removes every key under it. */
export const UNSENT_ANSWERS_PREFIX = 'pc-test-unsent:';

export const attemptCopyKey = (userId: string, classId: string, attemptId: string) =>
  `attempt-copy|${userId}|${classId}|${attemptId}`;

const copies = new Map<string, AttemptCopy>();

/** Resolves true once the browser's store holds the copy (false: this tab only, or signed out). */
export async function saveAttemptCopy(copy: AttemptCopy): Promise<boolean> {
  listen();
  if (signedOut.has(copy.userId)) return false;
  copies.set(copy.key, copy);
  return put(copy);
}

export async function readAttemptCopy(
  userId: string,
  classId: string,
  attemptId: string,
): Promise<AttemptCopy | null> {
  const key = attemptCopyKey(userId, classId, attemptId);
  const stored = (await run('readonly', (store) => store.get(key))) as
    | AttemptCopy
    | null
    | undefined;
  // The in-memory copy is the newest save, even when it did not reach the store (as `listDrafts`).
  const found = copies.get(key) ?? stored ?? null;
  return found && found.userId === userId && found.attemptId === attemptId ? found : null;
}

export async function removeAttemptCopy(
  userId: string,
  classId: string,
  attemptId: string,
): Promise<void> {
  const key = attemptCopyKey(userId, classId, attemptId);
  copies.delete(key);
  const db = await database();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Resolves once the browser's store has committed the delete (or could not take it). */
export async function removeDraft(key: string): Promise<void> {
  memory.delete(key);
  await pending(key, async () => {
    if (draftWriteHold.deletes) await draftWriteHold.deletes;
    const db = await database();
    if (!db) return;
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  });
}

/** Drafts of one person's work on one resource of one class, newest edit last. */
export async function listDrafts(
  userId: string,
  classId: string,
  resourceId: string,
): Promise<Draft[]> {
  listen();
  const stored = (await run('readonly', (store) => store.getAll())) ?? [];
  const merged = new Map<string, Draft>();
  for (const draft of stored as Draft[]) merged.set(draft.key, draft);
  for (const [key, draft] of memory) merged.set(key, draft);
  return [...merged.values()]
    .filter((d) => d.userId === userId && d.classId === classId && d.resourceId === resourceId)
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

/** Sign-out (§8): nothing of the account stays on the device. */
export async function clearDrafts(userId: string | null): Promise<void> {
  listen();
  memory.clear();
  copies.clear();
  // Unsent test answers kept by the Test page are the account's too (§8).
  try {
    for (const k of Object.keys(window.localStorage)) {
      if (k.startsWith(UNSENT_ANSWERS_PREFIX)) window.localStorage.removeItem(k);
    }
  } catch {
    // blocked storage holds nothing to clear
  }
  if (userId) signedOut.add(userId);
  const db = await database();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        store.clear();
        if (userId) store.put({ key: signedOutKey(userId), userId, kind: 'signed-out' });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }
  if (userId && typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage({ signedOut: userId });
    channel.close();
  }
}

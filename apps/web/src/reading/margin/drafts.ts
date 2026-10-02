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

/** People who signed out here: a save still in flight for them must not write the device again. */
const signedOut = new Set<string>();

/** A person is using this device again; their drafts are kept from now on. */
export const allowDrafts = (userId: string) => void signedOut.delete(userId);

/** Writes the draft; resolves true once the browser's store holds it (false: this tab only). */
export async function saveDraft(draft: Draft): Promise<boolean> {
  if (signedOut.has(draft.userId)) return false;
  memory.set(draft.key, draft);
  const key = await run('readwrite', (store) => store.put(draft));
  return key !== null;
}

export async function removeDraft(key: string): Promise<void> {
  memory.delete(key);
  await run('readwrite', (store) => store.delete(key));
}

/** Drafts of one person's work on one resource of one class, newest edit last. */
export async function listDrafts(
  userId: string,
  classId: string,
  resourceId: string,
): Promise<Draft[]> {
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
  if (userId) signedOut.add(userId);
  memory.clear();
  await run('readwrite', (store) => store.clear());
}

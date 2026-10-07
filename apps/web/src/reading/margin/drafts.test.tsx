import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  allowDrafts,
  attemptCopyKey,
  clearDrafts,
  type Draft,
  draftKey,
  listDrafts,
  readAttemptCopy,
  removeDraft,
  saveAttemptCopy,
  saveDraft,
  signedOutKey,
} from './drafts';

const draft = (user: string, id: string, body: string): Draft => ({
  key: draftKey(user, 'class-a', 'res-1', id),
  userId: user,
  classId: 'class-a',
  resourceId: 'res-1',
  kind: 'note',
  annotationId: null,
  expectedRevision: null,
  anchor: { kind: 'none' },
  body,
  audience: null,
  updatedAt: Date.now(),
});

beforeEach(async () => {
  await clearDrafts(null);
  await allowDrafts('sam');
  await allowDrafts('kim');
});

describe('device draft store', () => {
  it('A03 keeps an unsent note across a reload of the page', async () => {
    expect(await saveDraft(draft('sam', 'n1', 'unsent words'))).toBe(true);
    // A reload loses the tab's memory but not the browser's store.
    const reopened = await listDrafts('sam', 'class-a', 'res-1');
    expect(reopened.map((d) => d.body)).toEqual(['unsent words']);
  });

  it('shows a person only their own drafts for this class and reading', async () => {
    await saveDraft(draft('sam', 'n1', 'sam note'));
    await saveDraft(draft('kim', 'n1', 'kim note'));
    expect((await listDrafts('kim', 'class-a', 'res-1')).map((d) => d.body)).toEqual(['kim note']);
    expect(await listDrafts('sam', 'class-b', 'res-1')).toEqual([]);
    expect(await listDrafts('sam', 'class-a', 'res-2')).toEqual([]);
  });

  it('removes one draft', async () => {
    await saveDraft(draft('sam', 'n1', 'a'));
    await removeDraft(draftKey('sam', 'class-a', 'res-1', 'n1'));
    expect(await listDrafts('sam', 'class-a', 'res-1')).toEqual([]);
  });

  it('A03 sign-out clears every draft of the device, and a save still in flight cannot bring one back', async () => {
    await saveDraft(draft('sam', 'n1', 'a'));
    await saveDraft(draft('kim', 'n1', 'b'));
    await clearDrafts('sam');
    expect(await listDrafts('sam', 'class-a', 'res-1')).toEqual([]);
    expect(await listDrafts('kim', 'class-a', 'res-1')).toEqual([]);
    expect(await saveDraft(draft('sam', 'n2', 'late'))).toBe(false);
    expect(await listDrafts('sam', 'class-a', 'res-1')).toEqual([]);
    await allowDrafts('sam');
    expect(await saveDraft(draft('sam', 'n3', 'back'))).toBe(true);
  });

  it('A03 a sign-out made in another tab refuses this tab’s late save and its text is not kept', async () => {
    await saveDraft(draft('sam', 'n1', 'typed before'));
    // Another tab signs out: it clears the store and leaves the marker, and this tab is not told.
    const db = await new Promise<IDBDatabase>((resolve) => {
      const open = indexedDB.open('parallax-drafts', 1);
      open.onsuccess = () => resolve(open.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction('drafts', 'readwrite');
      tx.objectStore('drafts').clear();
      tx.objectStore('drafts').put({ key: signedOutKey('sam'), userId: 'sam', kind: 'signed-out' });
      tx.oncomplete = () => resolve();
    });
    // The reading unmounts here and its pending save fails with 401: the draft is offered again.
    expect(await saveDraft(draft('sam', 'n1', 'typed after sign-out'))).toBe(false);
    expect(await listDrafts('sam', 'class-a', 'res-1')).toEqual([]);
    // Session expiry is not sign-out: someone else's drafts are unaffected, and signing in again works.
    expect(await saveDraft(draft('kim', 'n1', 'kim note'))).toBe(true);
    await allowDrafts('sam');
    expect(await saveDraft(draft('sam', 'n2', 'back again'))).toBe(true);
  });

  it('A15 a later copy that did not reach the store is the one an instructor request sends', async () => {
    const copy = (value: string) => ({
      key: attemptCopyKey('sam', 'class-a', 'att-1'),
      userId: 'sam',
      kind: 'attempt-copy' as const,
      classId: 'class-a',
      attemptId: 'att-1',
      answers: [{ questionId: 'q1', value }],
      updatedAt: Date.now(),
    });
    expect(await saveAttemptCopy(copy('older'))).toBe(true);
    const refuse = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => {
      throw new Error('storage refused');
    });
    expect(await saveAttemptCopy(copy('newer'))).toBe(false);
    refuse.mockRestore();
    expect((await readAttemptCopy('sam', 'class-a', 'att-1'))?.answers).toEqual([
      { questionId: 'q1', value: 'newer' },
    ]);
  });
});

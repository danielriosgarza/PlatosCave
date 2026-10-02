import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  allowDrafts,
  clearDrafts,
  type Draft,
  draftKey,
  listDrafts,
  removeDraft,
  saveDraft,
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
  allowDrafts('sam');
  allowDrafts('kim');
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
    allowDrafts('sam');
    expect(await saveDraft(draft('sam', 'n3', 'back'))).toBe(true);
  });
});

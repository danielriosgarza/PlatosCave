import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Annotation,
  AUTOSAVE_MS,
  NoteController,
  type NoteDeps,
  type SendResult,
} from './notes';

const ANCHOR = { kind: 'none' } as const;

const annotation = (revision: number, body: string, id = 'n-1'): Annotation => ({
  id,
  resourceId: 'r',
  resourceRevisionId: 'rev',
  kind: 'note',
  audience: 'private',
  anchor: ANCHOR,
  body,
  color: null,
  revision,
  placement: null,
  createdAt: '2026-10-01T09:00:00Z',
  updatedAt: '2026-10-01T09:00:00Z',
});

function setup(init: Partial<ConstructorParameters<typeof NoteController>[0]> = {}) {
  const sent: string[] = [];
  const persisted: (string | null)[] = [];
  const acknowledged: Annotation[] = [];
  const forgotten: string[] = [];
  let next: SendResult[] = [];
  let revision = 0;
  const reply = (body: string): SendResult =>
    next.shift() ?? { kind: 'ok', annotation: annotation(++revision, body) };
  const deps: NoteDeps = {
    create: async (_a, body) => {
      sent.push(`create:${body}`);
      return reply(body);
    },
    save: async (id, rev, body, _final) => {
      sent.push(`save:${id}@${rev}:${body}`);
      return reply(body);
    },
    persist: (d) => void persisted.push(d ? d.body : null),
    acknowledged: (a) => acknowledged.push(a),
    forget: (id) => forgotten.push(id),
  };
  const controller = new NoteController(
    { key: 'k', anchor: ANCHOR, body: '', annotationId: null, revision: null, ...init },
    deps,
  );
  return {
    controller,
    sent,
    persisted,
    acknowledged,
    forgotten,
    queue: (...r: SendResult[]) => (next = r),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('note autosave', () => {
  it('A03 says Saved only once the device copy is gone', async () => {
    let finish: () => void = () => {};
    const deps: NoteDeps = {
      create: async (_a, body) => ({ kind: 'ok', annotation: annotation(1, body) }),
      save: async (_i, _r, body) => ({ kind: 'ok', annotation: annotation(2, body) }),
      persist: (d) =>
        d
          ? undefined
          : new Promise<void>((resolve) => {
              finish = resolve;
            }),
      acknowledged: () => {},
      forget: () => {},
    };
    const controller = new NoteController(
      { key: 'k', anchor: ANCHOR, body: '', annotationId: null, revision: null },
      deps,
    );
    controller.edit('Words');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(controller.state.status).toBe('saving');
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.state.status).toBe('saved');
  });

  it('A03 saves one second after the last edit, and says Saved only after the server answers', async () => {
    const { controller, sent, persisted } = setup();
    controller.edit('First');
    controller.edit('First thought');
    expect(controller.state.status).toBe('saving');
    expect(persisted.at(-1)).toBe('First thought'); // on this device at once
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 1);
    expect(sent).toEqual([]);
    expect(controller.state.status).toBe('saving');
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(['create:First thought']);
    expect(controller.state.status).toBe('saved');
    expect(persisted.at(-1)).toBeNull(); // the device copy goes once the server holds the text
  });

  it('saves at once on blur', async () => {
    const { controller, sent } = setup();
    controller.edit('Quick');
    controller.blur();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(['create:Quick']);
  });

  it('creates the note once and then saves against the revision it was given', async () => {
    const { controller, sent } = setup();
    controller.edit('One');
    controller.blur();
    await vi.advanceTimersByTimeAsync(0);
    controller.edit('One two');
    controller.blur();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(['create:One', 'save:n-1@1:One two']);
  });

  it('sends text typed during a request in the next request, never two at once', async () => {
    const { controller, sent } = setup();
    let release: (r: SendResult) => void = () => {};
    const deps = (controller as unknown as { deps: NoteDeps }).deps;
    deps.create = (_a, body) => {
      sent.push(`create:${body}`);
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    controller.edit('A');
    controller.blur();
    await vi.advanceTimersByTimeAsync(0);
    controller.edit('AB');
    controller.blur(); // still waiting for the first answer
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(sent).toEqual(['create:A']);
    release({ kind: 'ok', annotation: annotation(1, 'A') });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(sent).toEqual(['create:A', 'save:n-1@1:AB']);
  });

  it('does not create a note that was never written', async () => {
    const { controller, sent } = setup();
    controller.edit('   ');
    controller.blur();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(sent).toEqual([]);
    expect(controller.state.status).toBe('idle');
  });

  it('A03 while offline the text stays on this device, and goes when the browser is back online', async () => {
    const { controller, queue, persisted, sent } = setup({
      annotationId: 'n-1',
      revision: 1,
      body: 'Kept',
    });
    queue({ kind: 'offline' });
    controller.edit('Kept, then more');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(controller.state.status).toBe('offline');
    expect(persisted.at(-1)).toBe('Kept, then more');
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(['save:n-1@1:Kept, then more', 'save:n-1@1:Kept, then more']);
    expect(controller.state.status).toBe('saved');
  });

  it('A03 a refused save says Could not save, keeps the text and retries on request', async () => {
    const { controller, queue, persisted } = setup();
    queue({ kind: 'failed', reason: null });
    controller.edit('Words');
    controller.blur();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.state.status).toBe('failed');
    expect(controller.state.body).toBe('Words');
    expect(persisted.at(-1)).toBe('Words');
    controller.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.state.status).toBe('saved');
  });

  it('a stale revision shows the conflict and overwrites nothing until the person chooses', async () => {
    const { controller, queue, sent, acknowledged } = setup({
      annotationId: 'n-1',
      revision: 1,
      body: 'Original',
    });
    const server = annotation(3, 'A longer version written on another device');
    queue({ kind: 'conflict', current: server });
    controller.edit('Mine');
    controller.blur();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.state.status).toBe('conflict');
    expect(controller.state.conflict).toEqual(server);
    expect(controller.state.body).toBe('Mine');
    // Nothing more is sent while the choice is open, even if the timer would fire.
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 3);
    expect(sent).toHaveLength(1);
    expect(acknowledged).toEqual([]);

    controller.keepMine();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.at(-1)).toBe('save:n-1@3:Mine');
    expect(controller.state.status).toBe('saved');
  });

  it('choosing the saved version replaces the draft with it', async () => {
    const { controller, queue, persisted, acknowledged } = setup({
      annotationId: 'n-1',
      revision: 1,
      body: 'Original',
    });
    const server = annotation(2, 'Saved elsewhere');
    queue({ kind: 'conflict', current: server });
    controller.edit('Mine');
    controller.blur();
    await vi.advanceTimersByTimeAsync(0);
    controller.takeSaved();
    expect(controller.state).toMatchObject({
      body: 'Saved elsewhere',
      status: 'saved',
      conflict: null,
    });
    expect(acknowledged).toEqual([server]);
    expect(persisted.at(-1)).toBeNull();
  });

  it('a draft restored from the device is sent without waiting for an edit', async () => {
    const { sent } = setup({ annotationId: 'n-1', revision: 4, body: 'Left unsent', unsent: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(['save:n-1@4:Left unsent']);
  });

  it('sends a pending save when the reading goes away', async () => {
    const { controller, sent } = setup();
    controller.edit('Pending');
    controller.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(['create:Pending']);
  });
});

describe('deleting a note', () => {
  it('A03 waits for a create in flight, reports the id it made and lets nothing of it show', async () => {
    const { controller, acknowledged, persisted } = setup();
    let release: (r: SendResult) => void = () => {};
    const deps = (controller as unknown as { deps: NoteDeps }).deps;
    deps.create = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    controller.edit('Short-lived');
    controller.blur();
    await vi.advanceTimersByTimeAsync(0);
    const removal = controller.discard();
    const made = annotation(1, 'Short-lived', 'made-meanwhile');
    release({ kind: 'ok', annotation: made });
    expect(await removal).toEqual({
      id: 'made-meanwhile',
      annotation: made,
      revision: 1,
      body: 'Short-lived',
    });
    expect(acknowledged).toEqual([]);
    // The draft stays until the caller has deleted the note: a failed delete must not lose it.
    expect(persisted.at(-1)).toBe('Short-lived');
    controller.dispose();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2);
    expect(controller.state.status).toBe('saving'); // never reports a result for a deleted note
  });

  it('A03 a pending timer is cancelled, so nothing is created for a deleted draft', async () => {
    const { controller, sent } = setup();
    controller.edit('Never sent');
    expect(await controller.discard()).toMatchObject({ id: null, body: 'Never sent' });
    controller.dispose();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2);
    expect(sent).toEqual([]);
  });

  it('A03 a save that finds the note gone keeps the text and offers to save it as a new note', async () => {
    const { controller, queue, persisted, sent, forgotten } = setup({
      annotationId: 'n-1',
      revision: 1,
      body: 'x',
    });
    queue({ kind: 'gone' });
    controller.edit('xy');
    controller.blur();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.state).toMatchObject({ status: 'failed', gone: true, body: 'xy' });
    expect(persisted.at(-1)).toBe('xy'); // never reached the server, so it stays on this device

    controller.saveAsNew();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.at(-1)).toBe('create:xy');
    expect(forgotten).toEqual(['n-1']);
    expect(controller.state).toMatchObject({ status: 'saved', gone: false, created: true });
  });

  it('only the flush as the reading goes away is sent so it can outlive the page', async () => {
    const finals: boolean[] = [];
    const { controller } = setup({ annotationId: 'n-1', revision: 1, body: 'x' });
    const deps = (controller as unknown as { deps: NoteDeps }).deps;
    deps.save = async (_id, _rev, body, final) => {
      finals.push(final);
      return { kind: 'ok', annotation: annotation(2, body) };
    };
    controller.edit('xy');
    controller.blur();
    await vi.advanceTimersByTimeAsync(0);
    controller.edit('xyz');
    controller.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(finals).toEqual([false, true]);
  });
});

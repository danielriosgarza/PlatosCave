import 'fake-indexeddb/auto';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdDraftDeletes } from '../../test/draftHold';
import {
  CLASS_A,
  makeMe,
  makeTopics,
  renderApp,
  SAM_ID,
  stubApi,
  studentIn,
  T_SAMPLING,
} from '../../test/render';
import type { ReadingList } from '../readings';
import type { Annotation, MarginList, Thread } from './data';
import { allowDrafts, clearDrafts, draftKey, listDrafts, saveDraft } from './drafts';

const RES = '00000000-0000-4000-8000-000000000401';
const REV = '00000000-0000-4000-8000-000000000501';
const READING = `/classes/${CLASS_A}/topics/${T_SAMPLING}/reading`;
const B1 = 'aaaaaaaaaaa1';
const B2 = 'aaaaaaaaaaa2';
const B3 = 'aaaaaaaaaaa3';
const P2 = 'Every sample tells a slightly different story.';
const P3 = 'Wider samples vary less than narrow ones do.';
const HTML =
  `<h2 data-block-id="${B1}">Why samples vary</h2>` +
  `<p data-block-id="${B2}">${P2}</p>` +
  `<p data-block-id="${B3}">${P3}</p>`;

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

interface World {
  annotations: Annotation[];
  threads: Thread[];
  calls: Call[];
  /** Requests for annotations and threads fail like a dropped connection. */
  network: 'up' | 'down';
  /** Creates and saves wait for this before the server answers. */
  hold: Promise<void> | null;
  /** Annotation saves answer this status instead of working. */
  refuse: number | null;
  count: number;
  /** Answers discussion actions (reply, edit, delete, status, moderate) a test cares about. */
  respond: ((call: Call) => { status: number; body: unknown } | undefined) | null;
}

const world = (annotations: Annotation[] = [], threads: Thread[] = []): World => ({
  annotations,
  threads,
  calls: [],
  network: 'up',
  hold: null,
  refuse: null,
  count: 0,
  respond: null,
});

const placement = (anchor: Annotation['anchor']) => ({
  resourceRevisionId: REV,
  status: 'original' as const,
  anchor,
  confidence: null,
});

const textAnchor = (blockId: string, start: number, end: number, source: string) => ({
  kind: 'text' as const,
  blockId,
  start,
  end,
  quote: source.slice(start, end),
  prefix: source.slice(Math.max(0, start - 32), start),
  suffix: source.slice(end, end + 32),
});

const noteOf = (
  id: string,
  anchor: Annotation['anchor'],
  body: string | null,
  kind: 'note' | 'highlight' = 'note',
  revision = 1,
): Annotation => ({
  id,
  resourceId: RES,
  resourceRevisionId: REV,
  kind,
  audience: 'private',
  anchor,
  body,
  color: null,
  revision,
  placement: placement(anchor),
  createdAt: '2026-10-01T09:00:00Z',
  updatedAt: '2026-10-01T09:00:00Z',
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(900 + n).padStart(12, '0')}`;

function api(w: World) {
  const me = makeMe({ classes: [studentIn(CLASS_A, 'Class A')] });
  const readings: ReadingList = {
    lastRevisionId: REV,
    readings: [
      {
        resourceId: RES,
        revisionId: REV,
        title: 'Why samples vary',
        kind: 'native',
        position: null,
      },
    ],
  };
  const base = `/api/classes/${CLASS_A}`;
  const mock = stubApi((url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    if (url === '/api/me') return { status: 200, body: me };
    if (url === `${base}/topics`) return { status: 200, body: makeTopics() };
    if (url === `${base}/topics/${T_SAMPLING}/readings`) return { status: 200, body: readings };
    if (url === `${base}/resources/${REV}/reading`) {
      return {
        status: 200,
        body: {
          revisionId: REV,
          title: 'Why samples vary',
          kind: 'native',
          status: 'ready',
          error: null,
          sourceKey: null,
          html: HTML,
          pdf: null,
        },
      };
    }
    if (url === `${base}/positions`)
      return { status: 200, body: { updatedAt: '2026-10-01T09:00:00Z' } };
    if (url === `${base}/resources/${RES}/annotations` && method === 'GET') {
      const list: MarginList = { annotations: w.annotations, threads: w.threads };
      return { status: 200, body: list };
    }
    // The reviewed marks of the topic are not part of what these tests observe.
    if (url === `${base}/topics/${T_SAMPLING}/reviews`) {
      return { status: 200, body: { topicId: T_SAMPLING, complete: false, items: [] } };
    }
    w.calls.push({ method, url, body });
    if (url === `${base}/resources/${RES}/annotations` && method === 'POST') {
      const made = noteOf(
        uuid(++w.count),
        body?.anchor as Annotation['anchor'],
        (body?.body as string | undefined) ?? null,
        body?.kind as 'note' | 'highlight',
      );
      w.annotations = [...w.annotations, made];
      return { status: 200, body: made };
    }
    const saving = /\/annotations\/([^/]+)$/.exec(url);
    if (saving && method === 'PUT') {
      if (w.refuse) return { status: w.refuse, body: { error: 'down' } };
      const held = w.annotations.find((a) => a.id === saving[1]);
      if (!held) return { status: 404, body: {} };
      if (held.revision !== body?.expectedRevision) {
        return { status: 409, body: { error: 'revision_conflict', current: held } };
      }
      const saved = { ...held, body: body?.body as string, revision: held.revision + 1 };
      w.annotations = w.annotations.map((a) => (a.id === saved.id ? saved : a));
      return { status: 200, body: saved };
    }
    if (saving && method === 'DELETE') {
      w.annotations = w.annotations.filter((a) => a.id !== saving[1]);
      return { status: 200, body: { id: saving[1] } };
    }
    if (url === `${base}/resources/${RES}/threads` && method === 'POST') {
      const thread: Thread = {
        id: uuid(++w.count),
        resourceId: RES,
        resourceRevisionId: REV,
        anchor: body?.anchor as Thread['anchor'],
        audience: body?.audience as 'instructor' | 'class',
        status: 'open',
        author: { id: SAM_ID, name: 'Sam Okafor' },
        placement: placement(body?.anchor as Thread['anchor']),
        createdAt: '2026-10-01T09:00:00Z',
        can: { reply: true, resolve: false, reopen: false },
        posts: [
          {
            id: uuid(++w.count),
            parentId: null,
            author: { id: SAM_ID, name: 'Sam Okafor' },
            authorRole: 'student',
            body: body?.body as string,
            edited: false,
            deleted: false,
            moderated: false,
            can: { edit: false, delete: false, moderate: false },
            createdAt: '2026-10-01T09:00:00Z',
          },
        ],
      };
      w.threads = [...w.threads, thread];
      return { status: 200, body: thread };
    }
    const answered = w.respond?.({ method, url, body });
    if (answered) return answered;
    return { status: 404, body: {} };
  });
  // A dropped connection is a rejected fetch, which no HTTP answer can stand for.
  const answer = mock.getMockImplementation() as (
    i: RequestInfo | URL,
    n?: RequestInit,
  ) => Promise<Response>;
  mock.mockImplementation(async (input, init) => {
    if (w.network === 'down' && /\/(annotations|threads)/.test(String(input)) && init?.method) {
      throw new TypeError('Failed to fetch');
    }
    if (
      w.hold &&
      (init?.method === 'POST' || init?.method === 'PUT') &&
      /\/annotations/.test(String(input))
    ) {
      await w.hold;
    }
    return answer(input, init);
  });
  return mock;
}

/** The browser's own connectivity signal, as it reports going offline and coming back. */
const browserOffline = (off: boolean) => vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(!off);

/** What a reader does with the mouse: selects part of one block's text. */
function select(blockId: string, from: number, to: number) {
  const block = document.querySelector(`[data-block-id="${blockId}"]`) as HTMLElement;
  const text = block.firstChild as Text;
  const range = document.createRange();
  range.setStart(text, from);
  range.setEnd(text, to);
  const selection = window.getSelection() as Selection;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

const open = async () => {
  renderApp(READING);
  await screen.findByRole('button', { name: 'My notes' });
  await waitFor(() => expect(document.querySelector(`[data-block-id="${B2}"]`)).not.toBeNull());
};

const toolbar = () => screen.findByRole('toolbar', { name: 'Selected passage' });
const marks = () => [...document.querySelectorAll<HTMLElement>('mark[data-marks]')];

beforeEach(async () => {
  await clearDrafts(null);
  await allowDrafts(SAM_ID);
});

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('reading margin: selection and marks', () => {
  it('A05 selecting text opens Highlight, Note and Ask right after the passage’s block', async () => {
    api(world());
    await open();
    select(B3, 0, 5);
    const tools = await toolbar();
    const block = document.querySelector(`[data-block-id="${B3}"]`) as HTMLElement;
    expect(block.nextElementSibling).toContainElement(tools);
    expect(
      within(tools)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Highlight', 'Note', 'Ask']);
    // No separate Comment action duplicates Ask (§8).
    expect(screen.queryByRole('button', { name: 'Comment' })).toBeNull();
    // Collapsing the selection takes the toolbar away again.
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    await waitFor(() =>
      expect(screen.queryByRole('toolbar', { name: 'Selected passage' })).toBeNull(),
    );
  });

  it('A05 Highlight saves a private text highlight and marks the passage', async () => {
    const w = world();
    api(w);
    const user = userEvent.setup();
    await open();
    select(B3, 0, 13);
    await user.click(within(await toolbar()).getByRole('button', { name: 'Highlight' }));
    await waitFor(() => expect(w.calls).toHaveLength(1));
    expect(w.calls[0]?.body).toEqual({
      kind: 'highlight',
      anchor: textAnchor(B3, 0, 13, P3),
    });
    await waitFor(() => expect(marks().map((m) => m.textContent)).toEqual(['Wider samples']));
    expect(screen.queryByRole('toolbar', { name: 'Selected passage' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Highlight: Wider samples' })).toBeInTheDocument();
  });

  it('A05 a failed highlight says so beside the toolbar and keeps the selection to try again', async () => {
    const w = world();
    api(w);
    const user = userEvent.setup();
    await open();
    browserOffline(true);
    select(B3, 0, 13);
    await user.click(within(await toolbar()).getByRole('button', { name: 'Highlight' }));
    expect(await screen.findByText('Offline · not saved')).toBeInTheDocument();
    expect(marks()).toEqual([]);
    expect(screen.getByRole('toolbar', { name: 'Selected passage' })).toBeInTheDocument();
  });

  it('A05 a click on a mark opens its entry and an entry marks and scrolls to its passage', async () => {
    const first = noteOf(uuid(1), textAnchor(B2, 6, 12, P2), 'About samples');
    const second = noteOf(uuid(2), textAnchor(B3, 0, 5, P3), 'About width');
    api(world([first, second]));
    const user = userEvent.setup();
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    await open();
    await waitFor(() => expect(marks()).toHaveLength(2));

    await user.click(marks()[1] as HTMLElement);
    const editor = await screen.findByRole('textbox', { name: 'Your note' });
    expect(editor).toHaveValue('About width');
    expect(editor).toHaveFocus();
    expect(marks()[1]).toHaveAttribute('data-active', 'true');

    await user.click(screen.getByRole('button', { name: /^Note 1: sample/ }));
    expect(marks()[0]).toHaveAttribute('data-active', 'true');
    expect(marks()[1]).not.toHaveAttribute('data-active');
    expect(scroll).toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Your note' })).toHaveValue('About samples');
  });

  it('A05 several marks at one location show a count', async () => {
    api(
      world([
        noteOf(uuid(1), textAnchor(B3, 0, 12, P3), 'one'),
        noteOf(uuid(2), textAnchor(B3, 6, 12, P3), null, 'highlight'),
      ]),
    );
    await open();
    await waitFor(() => expect(document.querySelector('mark[data-count="2"]')).not.toBeNull());
    expect(document.querySelector('mark[data-count="2"]')?.textContent).toBe('sample');
  });

  it('A05 keeps a mark that needs reattachment out of the text and says so in the margin', async () => {
    const lost = {
      ...noteOf(uuid(1), textAnchor(B3, 0, 5, P3), 'Old words'),
      placement: {
        ...placement(textAnchor(B3, 0, 5, P3)),
        status: 'needs_reattachment' as const,
        anchor: null,
      },
    };
    api(world([lost]));
    await open();
    expect(await screen.findByText('Needs reattachment')).toBeInTheDocument();
    expect(marks()).toEqual([]);
    expect(screen.getByText('Wider')).toBeInTheDocument(); // the quote, kept as it was
  });

  it('A05 a note on a revision still being mapped says it is waiting to be placed, not lost', async () => {
    const waiting = {
      ...noteOf(uuid(1), textAnchor(B3, 0, 5, P3), 'Old words'),
      placement: {
        ...placement(textAnchor(B3, 0, 5, P3)),
        status: 'pending' as const,
        anchor: null,
      },
    };
    api(world([waiting]));
    await open();
    expect(await screen.findByText('Waiting to be placed')).toBeInTheDocument();
    expect(screen.queryByText('Needs reattachment')).toBeNull();
    expect(marks()).toEqual([]);
  });
});

describe('reading margin: notes and autosave', () => {
  it('A05 Note opens an editor beside the passage, focused, and saves a private note after a pause', async () => {
    const w = world();
    api(w);
    const user = userEvent.setup();
    await open();
    select(B3, 0, 13);
    await user.click(within(await toolbar()).getByRole('button', { name: 'Note' }));

    const editor = await screen.findByRole('textbox', { name: 'Your note' });
    expect(editor).toHaveFocus();
    expect(w.calls).toEqual([]); // nothing is created for an empty note
    await user.type(editor, 'Why not n minus one?');
    expect(await screen.findByText('Saving')).toBeInTheDocument();
    expect(w.calls).toEqual([]); // not before a second of inactivity
    expect(await screen.findByText('Saved', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]?.body).toEqual({
      kind: 'note',
      anchor: textAnchor(B3, 0, 13, P3),
      body: 'Why not n minus one?',
    });
    expect(w.annotations[0]?.audience).toBe('private');
    await waitFor(() => expect(marks().map((m) => m.textContent)).toEqual(['Wider samples']));
    // The typed text kept its place while the note was created.
    expect(screen.getByRole('textbox', { name: 'Your note' })).toHaveValue('Why not n minus one?');
  });

  it('A03 an acknowledged note is still there, with its mark, after a reload', async () => {
    const w = world();
    api(w);
    const user = userEvent.setup();
    await open();
    select(B3, 0, 13);
    await user.click(within(await toolbar()).getByRole('button', { name: 'Note' }));
    await user.type(await screen.findByRole('textbox', { name: 'Your note' }), 'Remember this');
    await screen.findByText('Saved', {}, { timeout: 4000 });

    cleanup();
    api(w);
    await open();
    expect(await screen.findByText('Remember this')).toBeInTheDocument();
    await waitFor(() => expect(marks().map((m) => m.textContent)).toEqual(['Wider samples']));
    expect(screen.queryByText('Saved')).toBeNull(); // nothing claims a save that did not just happen
    await user.click(marks()[0] as HTMLElement);
    expect(await screen.findByRole('textbox', { name: 'Your note' })).toHaveValue('Remember this');
  });

  it('A03 saves on blur without waiting out the pause', async () => {
    const w = world([noteOf(uuid(1), textAnchor(B3, 0, 5, P3), 'Draft')]);
    api(w);
    const user = userEvent.setup();
    await open();
    await user.click(await screen.findByRole('button', { name: /^Note 1/ }));
    await user.type(screen.getByRole('textbox', { name: 'Your note' }), ' more');
    await user.tab();
    await waitFor(() => expect(w.calls).toHaveLength(1));
    expect(w.calls[0]).toMatchObject({
      method: 'PUT',
      body: { expectedRevision: 1, body: 'Draft more' },
    });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('A03 a dropped connection keeps the text on this device and saves it when back online', async () => {
    const w = world([noteOf(uuid(1), textAnchor(B3, 0, 5, P3), 'Draft')]);
    api(w);
    const user = userEvent.setup();
    await open();
    await user.click(await screen.findByRole('button', { name: /^Note 1/ }));
    browserOffline(true);
    await user.type(screen.getByRole('textbox', { name: 'Your note' }), ' offline');
    expect(
      await screen.findByText('Offline · changes on this device', {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Saved')).toBeNull();
    const kept = await listDrafts(SAM_ID, CLASS_A, RES);
    expect(kept.map((d) => d.body)).toEqual(['Draft offline']);

    browserOffline(false);
    window.dispatchEvent(new Event('online'));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(w.annotations[0]?.body).toBe('Draft offline');
    await waitFor(async () => expect(await listDrafts(SAM_ID, CLASS_A, RES)).toEqual([]));
  });

  it('A03 a request that gets no answer while the browser says it is online offers Retry, not Offline', async () => {
    const w = world([noteOf(uuid(1), textAnchor(B3, 0, 5, P3), 'Draft')]);
    api(w);
    const user = userEvent.setup();
    await open();
    await user.click(await screen.findByRole('button', { name: /^Note 1/ }));
    w.network = 'down';
    await user.type(screen.getByRole('textbox', { name: 'Your note' }), '!');
    await user.tab();
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.queryByText(/^Offline/)).toBeNull();
    w.network = 'up';
    await user.click(retry);
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('A03 deleting a new note while its first save is in flight leaves nothing on the server, in the list or on the device', async () => {
    const w = world();
    const mock = api(w);
    const sent = (method: string) =>
      mock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === method);
    const user = userEvent.setup();
    await open();
    select(B3, 0, 13);
    await user.click(within(await toolbar()).getByRole('button', { name: 'Note' }));
    let release: () => void = () => {};
    w.hold = new Promise((resolve) => {
      release = resolve;
    });
    await user.type(await screen.findByRole('textbox', { name: 'Your note' }), 'Changed my mind');
    // Delete blurs the editor first, which sends the create; the answer is still pending.
    await user.click(screen.getByRole('button', { name: 'Delete note' }));
    await waitFor(() => expect(sent('POST')).toBe(true));
    release();
    await waitFor(() => expect(w.calls.some((c) => c.method === 'DELETE')).toBe(true));
    await waitFor(() => expect(w.annotations).toEqual([]));
    await waitFor(() => expect(marks()).toEqual([]));
    expect(screen.queryByText('Changed my mind')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Your note' })).toBeNull();
    expect(await listDrafts(SAM_ID, CLASS_A, RES)).toEqual([]);
  });

  it('A03 deleting a note while its save is in flight removes it for good and keeps no draft', async () => {
    const w = world([noteOf(uuid(1), textAnchor(B3, 0, 5, P3), 'Draft')]);
    const mock = api(w);
    const user = userEvent.setup();
    await open();
    await user.click(await screen.findByRole('button', { name: /^Note 1/ }));
    let release: () => void = () => {};
    w.hold = new Promise((resolve) => {
      release = resolve;
    });
    await user.type(screen.getByRole('textbox', { name: 'Your note' }), ' more');
    await user.click(screen.getByRole('button', { name: 'Delete note' }));
    await waitFor(() =>
      expect(
        mock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'PUT'),
      ).toBe(true),
    );
    release();
    await waitFor(() => expect(w.annotations).toEqual([]));
    await waitFor(() => expect(marks()).toEqual([]));
    expect(screen.queryByText(/Draft more/)).toBeNull();
    expect(await listDrafts(SAM_ID, CLASS_A, RES)).toEqual([]);
  });

  it('A03 a note deleted on another device keeps its text and can be saved as a new note', async () => {
    const w = world([noteOf(uuid(1), textAnchor(B3, 0, 5, P3), 'Draft')]);
    api(w);
    const user = userEvent.setup();
    await open();
    await user.click(await screen.findByRole('button', { name: /^Note 1/ }));
    w.annotations = [];
    await user.type(screen.getByRole('textbox', { name: 'Your note' }), '!');
    await user.tab();
    expect(await screen.findByText(/This note was deleted elsewhere/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Your note' })).toHaveValue('Draft!');
    expect((await listDrafts(SAM_ID, CLASS_A, RES)).map((d) => d.body)).toEqual(['Draft!']);

    await user.click(screen.getByRole('button', { name: 'Save as a new note' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(w.annotations.map((a) => a.body)).toEqual(['Draft!']);
    // One entry, not the stale one beside the new one.
    expect(screen.getAllByRole('button', { name: /^Note \d/ })).toHaveLength(1);
  });

  it('A03 a delete that fails keeps the note, its unsent edits and its draft, and says so', async () => {
    const w = world([noteOf(uuid(1), textAnchor(B3, 0, 5, P3), 'Draft')]);
    const mock = api(w);
    const user = userEvent.setup();
    await open();
    await user.click(await screen.findByRole('button', { name: /^Note 1/ }));
    browserOffline(true);
    await user.type(screen.getByRole('textbox', { name: 'Your note' }), ' edited offline');
    await screen.findByText('Offline · changes on this device', {}, { timeout: 4000 });
    // The delete itself is refused by the server.
    const answer = mock.getMockImplementation() as (
      i: RequestInfo | URL,
      n?: RequestInit,
    ) => Promise<Response>;
    mock.mockImplementation(async (input, init) =>
      init?.method === 'DELETE'
        ? new Response(JSON.stringify({ error: 'down' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          })
        : answer(input, init),
    );
    await user.click(screen.getByRole('button', { name: 'Delete note' }));

    const problem = await screen.findByRole('alert');
    expect(problem).toHaveTextContent('The note could not be deleted. Your text is kept.');
    // The editor's status line says what is saved; this message does not claim a save.
    expect(problem).not.toHaveTextContent(/saved/i);
    expect(screen.getByText('Offline · changes on this device')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Your note' })).toHaveValue('Draft edited offline');
    expect((await listDrafts(SAM_ID, CLASS_A, RES)).map((d) => d.body)).toEqual([
      'Draft edited offline',
    ]);
    expect(w.annotations).toHaveLength(1);
    expect(marks()).toHaveLength(1);

    // Back online and with the server answering again, Try again deletes it for good.
    browserOffline(false);
    mock.mockImplementation(answer);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(w.annotations).toEqual([]));
    await waitFor(async () => expect(await listDrafts(SAM_ID, CLASS_A, RES)).toEqual([]));
    expect(screen.queryByText('Draft edited offline')).toBeNull();
  });

  it('A03 a refused save says Could not save with Retry, keeps the text, and retries on request', async () => {
    const w = world([noteOf(uuid(1), textAnchor(B3, 0, 5, P3), 'Draft')]);
    api(w);
    const user = userEvent.setup();
    await open();
    await user.click(await screen.findByRole('button', { name: /^Note 1/ }));
    w.refuse = 503;
    await user.type(screen.getByRole('textbox', { name: 'Your note' }), '!');
    await user.tab();
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(retry.closest('[role="status"]')).toHaveTextContent('Could not save · Retry');
    expect(screen.getByRole('textbox', { name: 'Your note' })).toHaveValue('Draft!');
    w.refuse = null;
    await user.click(retry);
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(w.annotations[0]?.body).toBe('Draft!');
  });

  it('A03 a note changed elsewhere opens the conflict view and overwrites only on choice', async () => {
    const w = world([noteOf(uuid(1), textAnchor(B3, 0, 5, P3), 'Draft')]);
    api(w);
    const user = userEvent.setup();
    await open();
    await user.click(await screen.findByRole('button', { name: /^Note 1/ }));
    // Another device saves a longer version first.
    w.annotations = [
      noteOf(uuid(1), textAnchor(B3, 0, 5, P3), 'Draft, extended on my phone', 'note', 2),
    ];
    await user.type(screen.getByRole('textbox', { name: 'Your note' }), '!');
    await user.tab();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This note changed somewhere else');
    expect(alert).toHaveTextContent('Draft!');
    expect(alert).toHaveTextContent('Draft, extended on my phone');
    expect(w.annotations[0]?.body).toBe('Draft, extended on my phone');

    await user.click(within(alert).getByRole('button', { name: 'Keep my text' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(w.annotations[0]?.body).toBe('Draft!');
    expect(w.annotations[0]?.revision).toBe(3);
  });

  it('A03 a topic note has no anchor and is saved like any note', async () => {
    const w = world();
    api(w);
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: 'Add a topic note' }));
    await user.type(await screen.findByRole('textbox', { name: 'Your note' }), 'For the exam');
    await screen.findByText('Saved', {}, { timeout: 4000 });
    expect(w.calls[0]?.body).toEqual({
      kind: 'note',
      anchor: { kind: 'none' },
      body: 'For the exam',
    });
    expect(screen.getByRole('button', { name: /Topic note · no anchor/ })).toBeInTheDocument();
    expect(marks()).toEqual([]);
  });

  it('A03 deleting a note removes it from the margin and the reading', async () => {
    const w = world([noteOf(uuid(1), textAnchor(B3, 0, 5, P3), 'Gone soon')]);
    api(w);
    const user = userEvent.setup();
    await open();
    await user.click(await screen.findByRole('button', { name: /^Note 1/ }));
    await user.click(screen.getByRole('button', { name: 'Delete note' }));
    await waitFor(() => expect(w.annotations).toEqual([]));
    await waitFor(() => expect(marks()).toEqual([]));
    expect(screen.queryByText('Gone soon')).toBeNull();
  });

  it('A03 a remount while a note\u2019s server delete is still running does not bring the note back', async () => {
    const w = world([noteOf(uuid(1), textAnchor(B3, 0, 5, P3), 'Gone soon')]);
    Element.prototype.scrollIntoView = vi.fn();
    const mock = api(w);
    const original = mock.getMockImplementation() as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    let finish: () => void = () => {};
    const serverDelete = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mock.mockImplementation(async (input, init) => {
      if (init?.method === 'DELETE') {
        // The text typed before Delete is on the device (and unsent) while the server answers.
        await saveDraft({
          key: draftKey(SAM_ID, CLASS_A, RES, uuid(1)),
          userId: SAM_ID,
          classId: CLASS_A,
          resourceId: RES,
          kind: 'note',
          annotationId: uuid(1),
          expectedRevision: 1,
          anchor: textAnchor(B3, 0, 5, P3),
          body: 'Unsent edit',
          audience: null,
          updatedAt: Date.now(),
        });
        const answer = await original(input, init);
        await serverDelete;
        return answer;
      }
      return original(input, init);
    });
    const user = userEvent.setup();
    await open();
    await user.click(await screen.findByRole('button', { name: /^Note 1/ }));
    await user.type(screen.getByRole('textbox', { name: 'Your note' }), ' more');
    await user.click(screen.getByRole('button', { name: 'Delete note' }));
    await waitFor(async () => expect(await listDrafts(SAM_ID, CLASS_A, RES)).toHaveLength(1));
    await user.click(screen.getByRole('tab', { name: 'Slides' }));
    await user.click(screen.getByRole('tab', { name: 'Reading' }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Still deleting: the margin waits and does not offer the text again.
    expect(screen.queryByDisplayValue('Unsent edit')).toBeNull();
    finish();
    await screen.findByRole('button', { name: /^Discussion/ });
    await waitFor(async () => expect(await listDrafts(SAM_ID, CLASS_A, RES)).toEqual([]));
    expect(screen.queryByDisplayValue('Unsent edit')).toBeNull();
    expect(w.annotations).toEqual([]);
    // Nothing was sent after the delete: the note was not restored and saved again.
    const after = w.calls.slice(w.calls.findIndex((c) => c.method === 'DELETE') + 1);
    expect(after.filter((c) => c.method === 'PUT' || c.method === 'POST')).toEqual([]);
  });

  it('A03 restores a note typed but never sent from this device, and sends it', async () => {
    const w = world([noteOf(uuid(1), textAnchor(B3, 0, 5, P3), 'Draft')]);
    api(w);
    await saveDraft({
      key: draftKey(SAM_ID, CLASS_A, RES, uuid(1)),
      userId: SAM_ID,
      classId: CLASS_A,
      resourceId: RES,
      kind: 'note',
      annotationId: uuid(1),
      expectedRevision: 1,
      anchor: textAnchor(B3, 0, 5, P3),
      body: 'Draft written on the train',
      audience: null,
      updatedAt: Date.now(),
    });
    await open();
    await waitFor(() => expect(w.annotations[0]?.body).toBe('Draft written on the train'));
  });
});

describe('reading margin: Ask and the audience', () => {
  it('A05 Ask posts a question to the instructor only; the private note stays private', async () => {
    const w = world([noteOf(uuid(1), textAnchor(B2, 0, 5, P2), 'Private words')]);
    api(w);
    const user = userEvent.setup();
    await open();
    select(B3, 0, 13);
    await user.click(within(await toolbar()).getByRole('button', { name: 'Ask' }));

    // The audience is visible before posting, and Instructor is the narrower default.
    const audience = await screen.findByRole('combobox', { name: 'Visible to' });
    expect(audience).toHaveValue('instructor');
    expect(screen.getByText('Wider samples')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Comment or question' })).toHaveFocus();
    await user.type(
      screen.getByRole('textbox', { name: 'Comment or question' }),
      'Why does width matter?',
    );
    await user.click(screen.getByRole('button', { name: 'Post' }));

    await waitFor(() => expect(w.threads).toHaveLength(1));
    expect(w.calls.at(-1)?.body).toEqual({
      audience: 'instructor',
      anchor: textAnchor(B3, 0, 13, P3),
      body: 'Why does width matter?',
    });
    expect(await screen.findByText('You → Instructor')).toBeInTheDocument();
    expect(screen.getByText('Why does width matter?')).toBeInTheDocument();
    // The question is a thread, not a change to the private note.
    expect(w.annotations.map((a) => [a.id, a.audience, a.body])).toEqual([
      [uuid(1), 'private', 'Private words'],
    ]);
    expect(screen.getByRole('textbox', { name: 'Comment or question' })).toHaveValue('');
  });

  it('A05 the Class audience is posted as chosen and shown on the saved thread', async () => {
    const w = world();
    api(w);
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: /^Discussion/ }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Visible to' }), 'class');
    await user.type(
      screen.getByRole('textbox', { name: 'Comment or question' }),
      'Anyone else stuck?',
    );
    await user.click(screen.getByRole('button', { name: 'Post' }));
    expect(await screen.findByText('You → Class')).toBeInTheDocument();
    expect(w.threads[0]).toMatchObject({ audience: 'class', anchor: { kind: 'none' } });
  });

  it('A05 an unsent question and its audience survive a margin change, leaving the reading and a reload', async () => {
    const w = world();
    api(w);
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: /^Discussion/ }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Visible to' }), 'class');
    await user.type(screen.getByRole('textbox', { name: 'Comment or question' }), 'Half a thought');

    await user.click(screen.getByRole('button', { name: 'My notes' }));
    await user.click(screen.getByRole('button', { name: /^Discussion/ }));
    expect(screen.getByRole('combobox', { name: 'Visible to' })).toHaveValue('class');
    expect(screen.getByRole('textbox', { name: 'Comment or question' })).toHaveValue(
      'Half a thought',
    );

    cleanup(); // another tab, or a reload: the page's memory is gone
    api(w);
    await open();
    await user.click(screen.getByRole('button', { name: /^Discussion/ }));
    expect(await screen.findByDisplayValue('Half a thought')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Visible to' })).toHaveValue('class');
    expect(w.threads).toEqual([]); // never posted on its own
  });

  it('A05 restores an unsent question under React StrictMode, which mounts effects twice', async () => {
    const w = world();
    api(w);
    await saveDraft({
      key: draftKey(SAM_ID, CLASS_A, RES, 'ask'),
      userId: SAM_ID,
      classId: CLASS_A,
      resourceId: RES,
      kind: 'ask',
      annotationId: null,
      expectedRevision: null,
      anchor: { kind: 'none' },
      body: 'Left unsent yesterday',
      audience: 'class',
      updatedAt: Date.now(),
    });
    const user = userEvent.setup();
    renderApp(READING, { strict: true });
    await screen.findByRole('button', { name: 'My notes' });
    await user.click(screen.getByRole('button', { name: /^Discussion/ }));
    expect(await screen.findByDisplayValue('Left unsent yesterday')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Visible to' })).toHaveValue('class');
  });

  it('A05 text typed while a question is posting is kept as a new draft without the posted part', async () => {
    const w = world();
    api(w);
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: /^Discussion/ }));
    const box = screen.getByRole('textbox', { name: 'Comment or question' });
    await user.type(box, 'First question');
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mock = vi.mocked(fetch);
    const answer = mock.getMockImplementation() as (
      i: RequestInfo | URL,
      n?: RequestInit,
    ) => Promise<Response>;
    mock.mockImplementation(async (input, init) => {
      if (init?.method === 'POST' && String(input).endsWith('/threads')) await held;
      return answer(input, init);
    });
    await user.click(screen.getByRole('button', { name: 'Post' }));
    await user.type(box, ' and then more');
    release();
    expect(await screen.findByText('You → Instructor')).toBeInTheDocument();
    expect(w.threads[0]?.posts[0]?.body).toBe('First question');
    expect(box).toHaveValue(' and then more');
    expect((await listDrafts(SAM_ID, CLASS_A, RES)).map((d) => d.body)).toEqual([' and then more']);
  });

  it('A05 a question that cannot be posted keeps its text and offers Retry', async () => {
    const w = world();
    api(w);
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: /^Discussion/ }));
    browserOffline(true);
    await user.type(
      screen.getByRole('textbox', { name: 'Comment or question' }),
      'Is this on the test?',
    );
    await user.click(screen.getByRole('button', { name: 'Post' }));
    expect(
      await screen.findByText(/^Offline · your text is kept on this device/),
    ).toBeInTheDocument();
    browserOffline(false);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('You → Instructor')).toBeInTheDocument();
  });

  it('A05 lists only the threads the server returned, with who asked and who may read', async () => {
    const asked: Thread = {
      id: uuid(7),
      resourceId: RES,
      resourceRevisionId: REV,
      anchor: textAnchor(B3, 0, 5, P3),
      audience: 'class',
      status: 'open',
      author: { id: uuid(8), name: 'Ada Lovelace' },
      placement: placement(textAnchor(B3, 0, 5, P3)),
      createdAt: '2026-10-01T09:00:00Z',
      can: { reply: true, resolve: false, reopen: false },
      posts: [
        {
          id: uuid(9),
          parentId: null,
          author: { id: uuid(8), name: 'Ada Lovelace' },
          authorRole: 'student',
          body: 'A classmate’s question',
          edited: false,
          deleted: false,
          moderated: false,
          can: { edit: false, delete: false, moderate: false },
          createdAt: '2026-10-01T09:00:00Z',
        },
      ],
    };
    api(world([], [asked]));
    const user = userEvent.setup();
    await open();
    await waitFor(() => expect(marks()).toHaveLength(1));
    await user.click(marks()[0] as HTMLElement); // a mark opens its discussion entry
    expect(await screen.findByText('Ada Lovelace → Class')).toBeInTheDocument();
    expect(screen.getByText('A classmate’s question')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Discussion 1/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('reading margin: layout and sign-out', () => {
  it('A05 aligns the selected note with its passage after layout and again after a resize', async () => {
    const w = world([
      noteOf(uuid(1), textAnchor(B2, 0, 5, P2), 'Upper'),
      noteOf(uuid(2), textAnchor(B3, 0, 5, P3), 'Lower'),
    ]);
    api(w);
    const layout = { mark: 400 };
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      // The margin entry starts at 100, plus whatever shift it already carries.
      const shift = Number.parseFloat((this as HTMLElement).style?.marginTop) || 0;
      const top = this.matches('mark')
        ? layout.mark
        : this.matches('[data-active="true"]')
          ? 100 + shift
          : 0;
      return { top, bottom: top + 20, height: 20, left: 0, right: 0, width: 0 } as DOMRect;
    });
    const user = userEvent.setup();
    await open();
    await user.click(await screen.findByRole('button', { name: /^Note 2/ }));
    const entry = () =>
      screen
        .getByRole('textbox', { name: 'Your note' })
        .closest('[data-active="true"]') as HTMLElement;
    await waitFor(() => expect(entry().style.marginTop).toBe('300px'));

    layout.mark = 650; // the window was resized and the passage moved down
    window.dispatchEvent(new Event('resize'));
    await waitFor(() => expect(entry().style.marginTop).toBe('550px'));
  });

  it('A05 a note still being sent when the reading is left is not sent again when it is opened again', async () => {
    const w = world();
    const mock = api(w);
    const posts = () =>
      mock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    const user = userEvent.setup();
    await open();
    select(B3, 0, 13);
    await user.click(within(await toolbar()).getByRole('button', { name: 'Note' }));
    let release: () => void = () => {};
    w.hold = new Promise((resolve) => {
      release = resolve;
    });
    await user.type(await screen.findByRole('textbox', { name: 'Your note' }), 'one note');
    // Leaving the Reading tab sends the pending text; the answer is still held.
    await user.click(screen.getByRole('tab', { name: 'Slides' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    await user.click(screen.getByRole('tab', { name: 'Reading' }));
    await screen.findByRole('button', { name: 'My notes' });
    // Held: the text on the device is being sent, so it is not restored (and sent) a second time.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(posts()).toHaveLength(1);
    release();
    await waitFor(() => expect(w.annotations).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByText('one note')).toHaveLength(1));
    expect(w.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(posts()).toHaveLength(1);
    expect(await listDrafts(SAM_ID, CLASS_A, RES)).toEqual([]);
  });

  it('A03 a reload before the device copy is gone does not bring back an acknowledged note as unsent', async () => {
    const w = world();
    const mock = api(w);
    const posts = () =>
      mock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    // The device's delete of the acknowledged note's copy stays uncommitted: its transaction is
    // kept open by further requests until the test lets it finish.
    const realDelete = IDBObjectStore.prototype.delete;
    let released = false;
    const held: (() => void)[] = [];
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (
      this: IDBObjectStore,
      key,
    ) {
      if (typeof key !== 'string' || !key.startsWith(`${SAM_ID}|`)) {
        return realDelete.call(this, key);
      }
      const keepOpen = () => {
        const probe = this.get(key);
        probe.onsuccess = () => {
          if (!released) keepOpen();
          else realDelete.call(this, key);
        };
      };
      keepOpen();
      return {} as IDBRequest;
    });
    held.push(() => {
      released = true;
    });
    const user = userEvent.setup();
    await open();
    select(B3, 0, 13);
    await user.click(within(await toolbar()).getByRole('button', { name: 'Note' }));
    await user.type(await screen.findByRole('textbox', { name: 'Your note' }), 'one note');
    await waitFor(() => expect(posts()).toHaveLength(1));
    // "Saved" is only said once the device copy is really gone, so it cannot be said while held.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    // The reload: the margin comes back with whatever the device still holds.
    await user.click(screen.getByRole('tab', { name: 'Slides' }));
    await user.click(screen.getByRole('tab', { name: 'Reading' }));
    await screen.findByRole('button', { name: 'My notes' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.getAllByText('one note')).toHaveLength(1);
    expect(posts()).toHaveLength(1);
    expect(w.annotations).toHaveLength(1);
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    for (const finish of held) finish(); // the device commits at last; nothing is left pending
    await new Promise((resolve) => setTimeout(resolve, 30));
    vi.restoreAllMocks();
  });

  it('A05 a question still being posted when the reading is left does not come back as unsent text', async () => {
    const w = world();
    const mock = api(w);
    const answer = mock.getMockImplementation() as (
      i: RequestInfo | URL,
      n?: RequestInit,
    ) => Promise<Response>;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mock.mockImplementation(async (input, init) => {
      if (init?.method === 'POST' && /\/threads/.test(String(input))) await held;
      return answer(input, init);
    });
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: /^Discussion/ }));
    await user.type(
      screen.getByRole('textbox', { name: 'Comment or question' }),
      'Why n minus one?',
    );
    await user.click(screen.getByRole('button', { name: 'Post' }));
    await user.click(screen.getByRole('tab', { name: 'Slides' }));
    await user.click(screen.getByRole('tab', { name: 'Reading' }));
    await user.click(await screen.findByRole('button', { name: /^Discussion/ }));
    // Still posting: the text kept on the device is not offered again as unsent.
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await waitFor(() => expect(w.threads).toHaveLength(1));
    await waitFor(() => expect(screen.getByText('Why n minus one?')).toBeInTheDocument());
    expect(screen.getByRole('textbox', { name: 'Comment or question' })).toHaveValue('');
    expect(await listDrafts(SAM_ID, CLASS_A, RES)).toEqual([]);
  });

  it('A05 a reload before a posted question\u2019s device copy is gone does not bring it back as unsent', async () => {
    const w = world();
    api(w);
    // The device's delete of the posted question's draft stays uncommitted until the test lets it go.
    const release = holdDraftDeletes();
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: /^Discussion/ }));
    await user.type(
      screen.getByRole('textbox', { name: 'Comment or question' }),
      'Why n minus one?',
    );
    await user.click(screen.getByRole('button', { name: 'Post' }));
    await waitFor(() => expect(w.threads).toHaveLength(1));
    // The reload: the margin comes back with whatever the device still holds.
    await user.click(screen.getByRole('tab', { name: 'Slides' }));
    await user.click(screen.getByRole('tab', { name: 'Reading' }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The posted question is still being cleared from the device, so the margin waits and does not
    // offer it again.
    expect(screen.queryByDisplayValue('Why n minus one?')).toBeNull();
    release(); // the device commits at last
    await user.click(await screen.findByRole('button', { name: /^Discussion/ }));
    expect(screen.getByRole('textbox', { name: 'Comment or question' })).toHaveValue('');
    expect(w.threads).toHaveLength(1);
    expect(await listDrafts(SAM_ID, CLASS_A, RES)).toEqual([]);
  });

  it('A03 a remount before a deleted note\u2019s device copy is gone does not bring the note back', async () => {
    const w = world([noteOf(uuid(1), textAnchor(B3, 0, 5, P3), 'Gone soon')]);
    const mock = api(w);
    const original = mock.getMockImplementation() as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    let release: () => void = () => {};
    const late = {
      key: draftKey(SAM_ID, CLASS_A, RES, uuid(1)),
      userId: SAM_ID,
      classId: CLASS_A,
      resourceId: RES,
      kind: 'note' as const,
      annotationId: uuid(1),
      expectedRevision: 1,
      anchor: textAnchor(B3, 0, 5, P3),
      body: 'Unsent edit',
      audience: null,
      updatedAt: Date.now(),
    };
    mock.mockImplementation(async (input, init) => {
      if (init?.method === 'DELETE') {
        // A save that finished during the delete wrote the device copy again; clearing it is held.
        await saveDraft(late);
        release = holdDraftDeletes();
      }
      return original(input, init);
    });
    await saveDraft(late);
    const user = userEvent.setup();
    await open();
    await user.click(await screen.findByRole('button', { name: /^Note 1/ }));
    await user.click(screen.getByRole('button', { name: 'Delete note' }));
    await waitFor(() => expect(w.annotations).toEqual([]));
    // The server has deleted it; the device's copy is still being removed when the margin remounts.
    await user.click(screen.getByRole('tab', { name: 'Slides' }));
    await user.click(screen.getByRole('tab', { name: 'Reading' }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByDisplayValue('Unsent edit')).toBeNull();
    release();
    await screen.findByRole('button', { name: 'My notes' });
    await waitFor(async () => expect(await listDrafts(SAM_ID, CLASS_A, RES)).toEqual([]));
    expect(screen.queryByDisplayValue('Unsent edit')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Note 1/ })).toBeNull();
    expect(w.annotations).toEqual([]);
  });

  it('A05 a remount before a cleared question box\u2019s device copy is gone does not bring the text back', async () => {
    api(world());
    const release = holdDraftDeletes();
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: /^Discussion/ }));
    const box = screen.getByRole('textbox', { name: 'Comment or question' });
    await user.type(box, 'Why n minus one?');
    await waitFor(async () => expect(await listDrafts(SAM_ID, CLASS_A, RES)).toHaveLength(1));
    await user.clear(box);
    await user.click(screen.getByRole('tab', { name: 'Slides' }));
    await user.click(screen.getByRole('tab', { name: 'Reading' }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByDisplayValue('Why n minus one?')).toBeNull();
    release();
    await user.click(await screen.findByRole('button', { name: /^Discussion/ }));
    expect(screen.getByRole('textbox', { name: 'Comment or question' })).toHaveValue('');
    expect(await listDrafts(SAM_ID, CLASS_A, RES)).toEqual([]);
  });

  it('A03 hides the margin on request and brings it back with the notes still there', async () => {
    api(world([noteOf(uuid(1), textAnchor(B3, 0, 5, P3), 'Kept')]));
    const user = userEvent.setup();
    await open();
    expect(screen.getByRole('complementary', { name: 'Notes and discussion' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide notes' }));
    expect(screen.queryByRole('complementary')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Notes' }));
    expect(await screen.findByText('Kept')).toBeInTheDocument();
  });

  it('A03 signing out clears the unsent drafts of this device', async () => {
    const user = userEvent.setup();
    const w = world();
    const mock = api(w);
    const answer = mock.getMockImplementation() as (
      i: RequestInfo | URL,
      n?: RequestInit,
    ) => Promise<Response>;
    mock.mockImplementation(async (input, init) =>
      String(input) === '/api/auth/signout'
        ? new Response(JSON.stringify({ signedOut: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : answer(input, init),
    );
    await open();
    await user.click(screen.getByRole('button', { name: /^Discussion/ }));
    await user.type(
      screen.getByRole('textbox', { name: 'Comment or question' }),
      'Unsent on sign-out',
    );
    await waitFor(async () => expect(await listDrafts(SAM_ID, CLASS_A, RES)).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(async () => expect(await listDrafts(SAM_ID, CLASS_A, RES)).toEqual([]));
  });
});

describe('reading margin: follow-ups to the first review', () => {
  const sent = (mock: ReturnType<typeof api>, method: string) =>
    mock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === method);
  const refuseDelete = (mock: ReturnType<typeof api>) => {
    const answer = mock.getMockImplementation() as (
      i: RequestInfo | URL,
      n?: RequestInit,
    ) => Promise<Response>;
    mock.mockImplementation(async (input, init) =>
      init?.method === 'DELETE'
        ? new Response(JSON.stringify({ error: 'down' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          })
        : answer(input, init),
    );
  };

  it('A03 a note deleted elsewhere is still listed after a reload, with its text and Save as a new note', async () => {
    const w = world([noteOf(uuid(1), textAnchor(B3, 0, 5, P3), 'Draft')]);
    api(w);
    const user = userEvent.setup();
    await open();
    await user.click(await screen.findByRole('button', { name: /^Note 1/ }));
    w.annotations = [];
    await user.type(screen.getByRole('textbox', { name: 'Your note' }), '!');
    await user.tab();
    expect(await screen.findByText(/This note was deleted elsewhere/)).toBeInTheDocument();

    cleanup(); // a reload: the page's memory is gone, the draft on the device stays
    api(w);
    Element.prototype.scrollIntoView = vi.fn();
    await open();
    const entry = await screen.findByRole('button', { name: /^Note 1/ });
    expect(screen.getByText('Draft!')).toBeInTheDocument();
    await user.click(entry);
    expect(await screen.findByText(/This note was deleted elsewhere/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Your note' })).toHaveValue('Draft!');
    await user.click(screen.getByRole('button', { name: 'Save as a new note' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(w.annotations.map((a) => a.body)).toEqual(['Draft!']);
    expect(screen.getAllByRole('button', { name: /^Note \d/ })).toHaveLength(1);
  });

  it('A03 a failed delete after a save that finished during it keeps no stale draft', async () => {
    const w = world();
    const mock = api(w);
    const user = userEvent.setup();
    await open();
    select(B3, 0, 13);
    await user.click(within(await toolbar()).getByRole('button', { name: 'Note' }));
    let release: () => void = () => {};
    w.hold = new Promise((resolve) => {
      release = resolve;
    });
    await user.type(await screen.findByRole('textbox', { name: 'Your note' }), 'Created meanwhile');
    refuseDelete(mock);
    await user.click(screen.getByRole('button', { name: 'Delete note' }));
    await waitFor(() => expect(sent(mock, 'POST')).toBe(true));
    release();

    expect(await screen.findByRole('alert')).toHaveTextContent('The note could not be deleted');
    expect(screen.getByRole('textbox', { name: 'Your note' })).toHaveValue('Created meanwhile');
    expect(w.annotations.map((a) => a.body)).toEqual(['Created meanwhile']);
    // Nothing is unsent, so no draft remains to create the note a second time on reload.
    await waitFor(async () => expect(await listDrafts(SAM_ID, CLASS_A, RES)).toEqual([]));
  });

  it('A03 a failed delete with unsent edits rewrites the draft with the saved id and revision', async () => {
    const w = world();
    const mock = api(w);
    const user = userEvent.setup();
    await open();
    select(B3, 0, 13);
    await user.click(within(await toolbar()).getByRole('button', { name: 'Note' }));
    const editor = await screen.findByRole('textbox', { name: 'Your note' });
    await user.type(editor, 'First');
    await screen.findByText('Saved', {}, { timeout: 4000 });
    let release: () => void = () => {};
    w.hold = new Promise((resolve) => {
      release = resolve;
    });
    await user.type(editor, ' second');
    await user.tab(); // the save of the second part is sent and held
    await waitFor(() => expect(sent(mock, 'PUT')).toBe(true));
    refuseDelete(mock);
    w.hold = null;
    await user.click(screen.getByRole('button', { name: 'Delete note' }));
    release();
    expect(await screen.findByRole('alert')).toHaveTextContent('The note could not be deleted');
    const drafts = await listDrafts(SAM_ID, CLASS_A, RES);
    for (const d of drafts) {
      expect(d.annotationId).toBe(w.annotations[0]?.id);
      expect(d.expectedRevision).toBe(w.annotations[0]?.revision);
    }
  });

  it('A03 a tab that still shows a signed-out session does not undo the sign-out', async () => {
    const w = world();
    const mock = api(w);
    const { router } = renderApp(READING);
    await screen.findByRole('button', { name: 'My notes' });
    // Another tab signs the person out; this tab cannot re-check its session (the server is
    // unreachable) and keeps showing the cached one.
    await clearDrafts(SAM_ID);
    const answer = mock.getMockImplementation() as (
      i: RequestInfo | URL,
      n?: RequestInit,
    ) => Promise<Response>;
    mock.mockImplementation(async (input, init) => {
      if (String(input) === '/api/me') throw new TypeError('Failed to fetch');
      return answer(input, init);
    });
    router.history.push('/courses');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'My notes' })).toBeNull());
    router.history.push(READING);
    await screen.findByRole('button', { name: 'My notes' });
    await waitFor(() => expect(document.querySelector(`[data-block-id="${B2}"]`)).not.toBeNull());
    const refused = await saveDraft({
      key: draftKey(SAM_ID, CLASS_A, RES, 'ask'),
      userId: SAM_ID,
      classId: CLASS_A,
      resourceId: RES,
      kind: 'ask',
      annotationId: null,
      expectedRevision: null,
      anchor: { kind: 'none' },
      body: 'Must not be kept',
      audience: 'instructor',
      updatedAt: Date.now(),
    });
    expect(refused).toBe(false);
    expect(await listDrafts(SAM_ID, CLASS_A, RES)).toEqual([]);
  });

  it('A05 text typed while a question posts is kept without the part already posted', async () => {
    const w = world();
    const mock = api(w);
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: /^Discussion/ }));
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answer = mock.getMockImplementation() as (
      i: RequestInfo | URL,
      n?: RequestInit,
    ) => Promise<Response>;
    mock.mockImplementation(async (input, init) => {
      if (init?.method === 'POST' && /\/threads/.test(String(input))) await held;
      return answer(input, init);
    });
    const box = screen.getByRole('textbox', { name: 'Comment or question' });
    await user.type(box, 'First question');
    await user.click(screen.getByRole('button', { name: 'Post' }));
    await user.type(box, ' and a second');
    release();
    await waitFor(() => expect(w.threads).toHaveLength(1));
    await waitFor(() => expect(box).toHaveValue(' and a second'));
    expect(w.threads[0]?.posts[0]?.body).toBe('First question');
    // Posting again sends only the new part.
    await user.click(screen.getByRole('button', { name: 'Post' }));
    await waitFor(() => expect(w.threads).toHaveLength(2));
    expect(w.threads[1]?.posts[0]?.body).toBe('and a second');
  });

  it('A05 a second press on Highlight while the first is saving creates one highlight', async () => {
    const w = world();
    api(w);
    const user = userEvent.setup();
    await open();
    select(B3, 0, 13);
    const button = within(await toolbar()).getByRole('button', { name: 'Highlight' });
    let release: () => void = () => {};
    w.hold = new Promise((resolve) => {
      release = resolve;
    });
    await user.click(button);
    expect(button).toBeDisabled();
    await user.click(button);
    release();
    await waitFor(() => expect(marks()).toHaveLength(1));
    expect(w.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(w.annotations).toHaveLength(1);
  });
});

describe('discussion threads', () => {
  const ADA = { id: uuid(8), name: 'Ada Lovelace' };
  const MARCUS = { id: uuid(20), name: 'Marcus Webb' };
  const THREAD_ID = uuid(7);
  const post = (
    n: number,
    over: Partial<Thread['posts'][number]> = {},
  ): Thread['posts'][number] => ({
    id: uuid(n),
    parentId: null,
    author: { id: SAM_ID, name: 'Sam Okafor' },
    authorRole: 'student',
    body: `Post ${n}`,
    edited: false,
    deleted: false,
    moderated: false,
    can: { edit: true, delete: true, moderate: false },
    createdAt: '2026-10-01T09:00:00Z',
    ...over,
  });
  const threadOf = (
    posts: Thread['posts'],
    can: Thread['can'] = { reply: true, resolve: false, reopen: false },
    status: Thread['status'] = 'open',
  ): Thread => ({
    id: THREAD_ID,
    resourceId: RES,
    resourceRevisionId: REV,
    anchor: textAnchor(B3, 0, 5, P3),
    audience: 'class',
    status,
    author: ADA,
    placement: placement(textAnchor(B3, 0, 5, P3)),
    createdAt: '2026-10-01T09:00:00Z',
    can,
    posts,
  });
  const openDiscussion = async (user: ReturnType<typeof userEvent.setup>) => {
    await open();
    await user.click(await screen.findByRole('button', { name: /^Discussion/ }));
  };

  it('A05 an instructor response is labelled, and a reply shows what the server returned', async () => {
    const question = post(1, {
      author: ADA,
      body: 'Why n − 1?',
      can: { edit: false, delete: false, moderate: false },
    });
    const w = world([], [threadOf([question])]);
    const response = post(2, {
      parentId: question.id,
      author: MARCUS,
      authorRole: 'instructor',
      body: 'Because the mean is estimated.',
      can: { edit: false, delete: false, moderate: true },
    });
    w.respond = (c) =>
      c.url.endsWith(`/threads/${THREAD_ID}/posts`) && c.method === 'POST'
        ? { status: 200, body: threadOf([question, response]) }
        : undefined;
    api(w);
    const user = userEvent.setup();
    await openDiscussion(user);
    await user.click(await screen.findByRole('button', { name: 'Reply' }));
    await user.type(
      screen.getByRole('textbox', { name: /Reply to Ada Lovelace/ }),
      'Because the mean is estimated.',
    );
    await user.click(screen.getByRole('button', { name: 'Post reply' }));
    expect(await screen.findByText('Marcus Webb · Instructor')).toBeInTheDocument();
    expect(w.calls.at(-1)).toMatchObject({
      method: 'POST',
      body: { body: 'Because the mean is estimated.', parentId: question.id },
    });
  });

  it('A05 edit shows the edited indicator only after the server answers; delete leaves a tombstone', async () => {
    const mine = post(1);
    const w = world([], [threadOf([mine])]);
    w.respond = (c) => {
      if (c.method === 'PUT' && c.url.endsWith(`/posts/${mine.id}`)) {
        return {
          status: 200,
          body: threadOf([{ ...mine, body: c.body?.body as string, edited: true }]),
        };
      }
      if (c.method === 'DELETE' && c.url.endsWith(`/posts/${mine.id}`)) {
        return {
          status: 200,
          body: threadOf([
            {
              ...mine,
              body: null,
              deleted: true,
              can: { edit: false, delete: false, moderate: false },
            },
          ]),
        };
      }
      return undefined;
    };
    api(w);
    const user = userEvent.setup();
    await openDiscussion(user);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: 'Edit post' });
    await user.clear(box);
    await user.type(box, 'Reworded');
    await user.click(screen.getByRole('button', { name: 'Save edit' }));
    expect(await screen.findByText('Reworded')).toBeInTheDocument();
    expect(screen.getByText(/· Edited/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('The author deleted this post.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('A05 offers no edit or delete where the class policy forbids it, and shows a refusal', async () => {
    const mine = post(1, { can: { edit: false, delete: false, moderate: false } });
    api(world([], [threadOf([mine])]));
    const user = userEvent.setup();
    await openDiscussion(user);
    await screen.findByText('Post 1');
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('A05 the asker reopens a resolved question; an instructor resolves with Mark resolved', async () => {
    const question = post(1, { author: ADA, can: { edit: false, delete: false, moderate: false } });
    const w = world(
      [],
      [threadOf([question], { reply: true, resolve: false, reopen: true }, 'resolved')],
    );
    w.respond = (c) =>
      c.url.endsWith(`/threads/${THREAD_ID}/status`)
        ? {
            status: 200,
            body: threadOf(
              [question],
              { reply: true, resolve: true, reopen: false },
              c.body?.status as 'open',
            ),
          }
        : undefined;
    api(w);
    const user = userEvent.setup();
    await openDiscussion(user);
    expect(await screen.findByText('Resolved')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(await screen.findByText('Open')).toBeInTheDocument();
    expect(w.calls.at(-1)?.body).toEqual({ status: 'open' });
    expect(screen.getByRole('button', { name: 'Mark resolved' })).toBeInTheDocument();
  });

  it('A05 moderation asks for a reason and shows the removal the server recorded', async () => {
    const theirs = post(1, { author: ADA, can: { edit: false, delete: false, moderate: true } });
    const w = world([], [threadOf([theirs])]);
    w.respond = (c) =>
      c.url.endsWith(`/posts/${theirs.id}/moderate`)
        ? {
            status: 200,
            body: threadOf([
              {
                ...theirs,
                body: null,
                moderated: true,
                can: { edit: false, delete: false, moderate: false },
              },
            ]),
          }
        : undefined;
    api(w);
    const user = userEvent.setup();
    await openDiscussion(user);
    await user.click(await screen.findByRole('button', { name: 'Remove as instructor' }));
    expect(screen.getByRole('button', { name: 'Remove post' })).toBeDisabled();
    await user.type(
      screen.getByRole('textbox', { name: 'Reason for removing this post' }),
      'Off topic',
    );
    await user.click(screen.getByRole('button', { name: 'Remove post' }));
    expect(await screen.findByText('An instructor removed this post.')).toBeInTheDocument();
    expect(w.calls.at(-1)?.body).toEqual({ reason: 'Off topic' });
  });

  it('A05 an archived class refusal is shown and the post is not changed', async () => {
    const mine = post(1);
    const w = world([], [threadOf([mine])]);
    w.respond = (c) =>
      c.method === 'DELETE' ? { status: 409, body: { error: 'class_archived' } } : undefined;
    api(w);
    const user = userEvent.setup();
    await openDiscussion(user);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(/This class is archived/)).toBeInTheDocument();
    expect(screen.getByText('Post 1')).toBeInTheDocument();
  });

  it('A05 a thread whose posts are all removed still offers a reply to the discussion', async () => {
    const gone = post(1, {
      author: ADA,
      body: null,
      deleted: true,
      can: { edit: false, delete: false, moderate: false },
    });
    const w = world([], [threadOf([gone])]);
    w.respond = (c) =>
      c.url.endsWith(`/threads/${THREAD_ID}/posts`)
        ? {
            status: 200,
            body: threadOf([gone, post(2, { parentId: gone.id, body: 'Still here' })]),
          }
        : undefined;
    api(w);
    const user = userEvent.setup();
    await openDiscussion(user);
    await user.click(await screen.findByRole('button', { name: 'Reply to this discussion' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Reply to this discussion' }),
      'Still here',
    );
    await user.click(screen.getByRole('button', { name: 'Post reply' }));
    expect(await screen.findByText('Still here')).toBeInTheDocument();
    expect(w.calls.at(-1)?.body).toEqual({ body: 'Still here', parentId: undefined });
  });
});

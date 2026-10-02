import 'fake-indexeddb/auto';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  /** Annotation saves answer this status instead of working. */
  refuse: number | null;
  count: number;
}

const world = (annotations: Annotation[] = [], threads: Thread[] = []): World => ({
  annotations,
  threads,
  calls: [],
  network: 'up',
  refuse: null,
  count: 0,
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
        posts: [
          {
            id: uuid(++w.count),
            parentId: null,
            author: { id: SAM_ID, name: 'Sam Okafor' },
            body: body?.body as string,
            edited: false,
            deleted: false,
            moderated: false,
            createdAt: '2026-10-01T09:00:00Z',
          },
        ],
      };
      w.threads = [...w.threads, thread];
      return { status: 200, body: thread };
    }
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
    return answer(input, init);
  });
  return mock;
}

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
  allowDrafts(SAM_ID);
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
    w.network = 'down';
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
    w.network = 'down';
    await user.type(screen.getByRole('textbox', { name: 'Your note' }), ' offline');
    expect(
      await screen.findByText('Offline · changes on this device', {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Saved')).toBeNull();
    const kept = await listDrafts(SAM_ID, CLASS_A, RES);
    expect(kept.map((d) => d.body)).toEqual(['Draft offline']);

    w.network = 'up';
    window.dispatchEvent(new Event('online'));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(w.annotations[0]?.body).toBe('Draft offline');
    await waitFor(async () => expect(await listDrafts(SAM_ID, CLASS_A, RES)).toEqual([]));
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

  it('A05 a question that cannot be posted keeps its text and offers Retry', async () => {
    const w = world();
    api(w);
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: /^Discussion/ }));
    w.network = 'down';
    await user.type(
      screen.getByRole('textbox', { name: 'Comment or question' }),
      'Is this on the test?',
    );
    await user.click(screen.getByRole('button', { name: 'Post' }));
    expect(
      await screen.findByText(/^Offline · your text is kept on this device/),
    ).toBeInTheDocument();
    w.network = 'up';
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
      posts: [
        {
          id: uuid(9),
          parentId: null,
          author: { id: uuid(8), name: 'Ada Lovelace' },
          body: 'A classmate’s question',
          edited: false,
          deleted: false,
          moderated: false,
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

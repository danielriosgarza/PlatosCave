import 'fake-indexeddb/auto';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Annotation, MarginList, Thread } from '../reading/margin/data';
import { allowDrafts, clearDrafts, draftKey, saveDraft } from '../reading/margin/drafts';
import type { PdfDocument } from '../reading/pdfjs';
import {
  CLASS_A,
  makeMe,
  makeTopics,
  renderApp,
  SAM_ID,
  stubApi,
  studentIn,
  T_SAMPLING,
} from '../test/render';

const openPdf = vi.hoisted(() => vi.fn());
vi.mock('../reading/pdfjs', () => ({ openPdf }));

const RES = '00000000-0000-4000-8000-000000000401';
const REV = '00000000-0000-4000-8000-000000000601';
const SLIDES = `/classes/${CLASS_A}/topics/${T_SAMPLING}/slides`;
const BASE = `/api/classes/${CLASS_A}`;
const PAGES = 12;

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

interface World {
  annotations: Annotation[];
  threads: Thread[];
  calls: Call[];
  count: number;
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(900 + n).padStart(12, '0')}`;

const placed = (anchor: Annotation['anchor']) => ({
  resourceRevisionId: REV,
  status: 'original' as const,
  anchor,
  confidence: null,
});

const note = (id: string, page: number, body: string): Annotation => {
  const anchor = { kind: 'slide' as const, page };
  return {
    id,
    resourceId: RES,
    resourceRevisionId: REV,
    kind: 'note',
    audience: 'private',
    anchor,
    body,
    color: null,
    revision: 1,
    placement: placed(anchor),
    createdAt: '2026-10-01T09:00:00Z',
    updatedAt: '2026-10-01T09:00:00Z',
  };
};

function api(w: World) {
  const me = makeMe({ classes: [studentIn(CLASS_A, 'Class A')] });
  return stubApi((url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    if (url === '/api/me') return { status: 200, body: me };
    if (url === `${BASE}/topics`) return { status: 200, body: makeTopics() };
    if (url === `${BASE}/topics/${T_SAMPLING}/slides`) {
      return {
        status: 200,
        body: {
          lastRevisionId: REV,
          decks: [{ resourceId: RES, revisionId: REV, title: 'Sampling lecture', position: null }],
        },
      };
    }
    if (url === `${BASE}/positions`)
      return { status: 200, body: { updatedAt: '2026-10-01T09:00:00Z' } };
    if (url === `${BASE}/resources/${REV}/slides`) {
      return {
        status: 200,
        body: {
          revisionId: REV,
          title: 'Sampling lecture',
          status: 'ready',
          error: null,
          sourceKey: null,
          web: null,
          pdf: {
            url: 'http://localhost:3100/content/deck-1',
            expiresAt: '2026-10-01T09:05:00Z',
            pageCount: PAGES,
          },
        },
      };
    }
    if (url === `${BASE}/resources/${RES}/annotations` && method === 'GET') {
      const list: MarginList = { annotations: w.annotations, threads: w.threads };
      return { status: 200, body: list };
    }
    w.calls.push({ method, url, body });
    if (url === `${BASE}/resources/${RES}/annotations` && method === 'POST') {
      const made = note(
        uuid(++w.count),
        (body?.anchor as { page: number } | undefined)?.page ?? 0,
        String(body?.body),
      );
      w.annotations = [...w.annotations, made];
      return { status: 200, body: made };
    }
    const saving = /\/annotations\/([^/]+)$/.exec(url);
    if (saving && method === 'PUT') {
      const held = w.annotations.find((a) => a.id === saving[1]);
      if (!held) return { status: 404, body: {} };
      const saved = { ...held, body: String(body?.body), revision: held.revision + 1 };
      w.annotations = w.annotations.map((a) => (a.id === saved.id ? saved : a));
      return { status: 200, body: saved };
    }
    if (url === `${BASE}/resources/${RES}/threads` && method === 'POST') {
      const anchor = body?.anchor as Thread['anchor'];
      const thread: Thread = {
        id: uuid(++w.count),
        resourceId: RES,
        resourceRevisionId: REV,
        anchor,
        audience: body?.audience as 'instructor' | 'class',
        status: 'open',
        author: { id: SAM_ID, name: 'Sam Okafor' },
        placement: placed(anchor),
        createdAt: '2026-10-01T09:00:00Z',
        can: { reply: true, resolve: false, reopen: false },
        posts: [
          {
            id: uuid(++w.count),
            parentId: null,
            author: { id: SAM_ID, name: 'Sam Okafor' },
            authorRole: 'student',
            body: String(body?.body),
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
    return { status: 404, body: {} };
  });
}

const world = (annotations: Annotation[] = [], threads: Thread[] = []): World => ({
  annotations,
  threads,
  calls: [],
  count: 0,
});

function pdfDocument() {
  const doc: PdfDocument = {
    pageCount: PAGES,
    pageRatio: async () => 16 / 9,
    renderPage: vi.fn((_n: number, _target, width: number) => ({
      done: Promise.resolve({ width, height: Math.round((width * 9) / 16) }),
      cancel: () => undefined,
    })),
    destroy: vi.fn(),
  };
  return doc;
}

beforeEach(async () => {
  openPdf.mockReset();
  openPdf.mockResolvedValue(pdfDocument());
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(978);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(550);
  await clearDrafts(null);
  await allowDrafts(SAM_ID);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const openNotes = async (user: ReturnType<typeof userEvent.setup>) => {
  renderApp(SLIDES);
  const stage = await screen.findByRole('region', { name: 'Slide viewer' });
  await user.click(await screen.findByRole('button', { name: 'Notes' }));
  return { stage, margin: screen.getByRole('complementary', { name: 'Slide notes' }) };
};
const position = () => screen.getByText(/^\d+ \/ 12$/);
const noteField = (slide: number) => screen.findByLabelText(`Your note on slide ${slide}`);

describe('slide notes', () => {
  it('A24 a note typed on one slide is saved to that slide, and the next slide opens with its own empty note', async () => {
    const user = userEvent.setup();
    const w = world();
    api(w);
    const { stage, margin } = await openNotes(user);
    await user.type(await noteField(1), 'Sample size matters');
    await waitFor(() => expect(within(margin).getByText('Saved')).toBeVisible());
    expect(w.calls.filter((c) => c.method === 'POST')).toEqual([
      expect.objectContaining({
        body: { kind: 'note', anchor: { kind: 'slide', page: 0 }, body: 'Sample size matters' },
      }),
    ]);

    stage.focus();
    await user.keyboard('{ArrowRight}');
    expect(position()).toHaveTextContent('2 / 12');
    expect(await noteField(2)).toHaveValue('');
    expect(screen.queryByLabelText('Your note on slide 1')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await noteField(1)).toHaveValue('Sample size matters');
  });

  it('A24 moving to another slide neither loses nor overwrites the draft of the slide left behind', async () => {
    const user = userEvent.setup();
    const w = world();
    api(w);
    await openNotes(user);
    await user.type(await noteField(1), 'draft for one');
    // Leave at once: the pending text is sent for slide 1, not typed into slide 2.
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await noteField(2)).toHaveValue('');
    await user.type(await noteField(2), 'draft for two');
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await noteField(1)).toHaveValue('draft for one');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await noteField(2)).toHaveValue('draft for two');
    await waitFor(() =>
      expect(
        w.calls.filter((c) => c.method === 'POST').map((c) => [c.body?.anchor, c.body?.body]),
      ).toEqual(
        expect.arrayContaining([
          [{ kind: 'slide', page: 0 }, 'draft for one'],
          [{ kind: 'slide', page: 1 }, 'draft for two'],
        ]),
      ),
    );
    expect(w.annotations.map((a) => a.body).sort()).toEqual(['draft for one', 'draft for two']);
  });

  it('A24 an unsent question keeps its text and audience for its own slide only', async () => {
    const user = userEvent.setup();
    api(world());
    await openNotes(user);
    await user.click(screen.getByRole('button', { name: /^Discussion/ }));
    await user.selectOptions(screen.getByLabelText('Visible to'), 'class');
    await user.type(screen.getByLabelText('Comment or question'), 'Why n − 1?');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByLabelText('Comment or question')).toHaveValue('');
    expect(screen.getByLabelText('Visible to')).toHaveValue('instructor');
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(screen.getByLabelText('Comment or question')).toHaveValue('Why n − 1?');
    expect(screen.getByLabelText('Visible to')).toHaveValue('class');
  });

  it('A24 a posted question is anchored to its slide, labelled with its audience, and listed only there', async () => {
    const user = userEvent.setup();
    const w = world();
    api(w);
    await openNotes(user);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: /^Discussion/ }));
    await user.type(screen.getByLabelText('Comment or question'), 'Is slide 2 on the test?');
    await user.click(screen.getByRole('button', { name: 'Post' }));
    const margin = screen.getByRole('complementary', { name: 'Slide notes' });
    expect(await within(margin).findByText('You → Instructor')).toBeVisible();
    expect(within(margin).getByText('Is slide 2 on the test?')).toBeVisible();
    expect(w.calls.at(-1)?.body).toEqual({
      audience: 'instructor',
      anchor: { kind: 'slide', page: 1 },
      body: 'Is slide 2 on the test?',
    });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(within(margin).queryByText('Is slide 2 on the test?')).toBeNull();
    expect(within(margin).getByText('No questions or comments on this slide yet.')).toBeVisible();
  });

  it('A24 notes the new deck revision could not place stay listed as needing reattachment', async () => {
    const user = userEvent.setup();
    const lost = note(uuid(50), 4, 'Remember the formula');
    lost.placement = { ...placed(lost.anchor), status: 'needs_reattachment', anchor: null };
    api(world([lost, note(uuid(51), 0, 'Opening remark')]));
    const { margin } = await openNotes(user);
    expect(await noteField(1)).toHaveValue('Opening remark');
    const earlier = within(margin).getByRole('region', {
      name: 'Notes on an earlier version of this deck',
    });
    expect(within(earlier).getByText('Slide 5')).toBeVisible();
    expect(within(earlier).getByText('Needs reattachment')).toBeVisible();
    expect(within(earlier).getByText('Remember the formula')).toBeVisible();
  });

  it('A24 an unsent note kept on this device (offline) is restored to its slide, on first open and after Hide notes', async () => {
    const user = userEvent.setup();
    await saveDraft({
      key: draftKey(SAM_ID, CLASS_A, RES, 'slide-3'),
      userId: SAM_ID,
      classId: CLASS_A,
      resourceId: RES,
      kind: 'note',
      annotationId: null,
      expectedRevision: null,
      anchor: { kind: 'slide', page: 2 },
      body: 'unsent text',
      audience: null,
      updatedAt: Date.now(),
    });
    api(world());
    // Offline, so the text stays only on this device and hiding the margin cannot send it.
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const { stage } = await openNotes(user);
    expect(await noteField(1)).toHaveValue('');
    stage.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    await waitFor(async () => expect(await noteField(3)).toHaveValue('unsent text'));
    // Hidden and shown again, with the list already cached.
    await user.click(screen.getByRole('button', { name: 'Hide notes' }));
    await user.click(screen.getByRole('button', { name: 'Notes' }));
    await waitFor(async () => expect(await noteField(3)).toHaveValue('unsent text'));
  });

  it('A24 an unsent edit of a saved note is restored over the saved text', async () => {
    const user = userEvent.setup();
    const saved = note(uuid(60), 0, 'saved text');
    await saveDraft({
      key: draftKey(SAM_ID, CLASS_A, RES, saved.id),
      userId: SAM_ID,
      classId: CLASS_A,
      resourceId: RES,
      kind: 'note',
      annotationId: saved.id,
      expectedRevision: 1,
      anchor: saved.anchor,
      body: 'saved text, then more',
      audience: null,
      updatedAt: Date.now(),
    });
    api(world([saved]));
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await openNotes(user);
    await waitFor(async () => expect(await noteField(1)).toHaveValue('saved text, then more'));
  });
});

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLASS_A,
  COURSE,
  instructorIn,
  makeMe,
  makeTopics,
  renderApp,
  stubApi,
  studentIn,
  T_SAMPLING,
} from '../test/render';
import type { PdfDocument } from './pdfjs';
import type { ReadingList } from './readings';

const openPdf = vi.hoisted(() => vi.fn());
vi.mock('./pdfjs', () => ({ openPdf }));

const REV_NATIVE = '00000000-0000-4000-8000-000000000501';
const REV_PDF = '00000000-0000-4000-8000-000000000502';
const REV_PENDING = '00000000-0000-4000-8000-000000000503';
const REV_FAILED = '00000000-0000-4000-8000-000000000504';
const SOURCE_KEY = `courses/${COURSE}/objects/${'a'.repeat(64)}`;
const RES = '00000000-0000-4000-8000-000000000401';
const DOWNLOAD_URL = 'http://localhost:3100/content/download-1';
const PDF_URL = 'http://localhost:3100/content/token-1';
const READING = `/classes/${CLASS_A}/topics/${T_SAMPLING}/reading`;

const HTML =
  '<h2 data-block-id="b-title">Why samples vary</h2>' +
  '<p data-block-id="b-one">Every sample tells a slightly different story.</p>' +
  '<p data-block-id="b-two">Wider samples vary less than narrow ones do.</p>' +
  '<pre data-block-id="b-code"><code class="hljs language-python">print(1)</code></pre>';

const summary = (
  revisionId: string,
  title: string,
  kind: 'native' | 'pdf',
  position: ReadingList['readings'][number]['position'] = null,
) => ({ resourceId: RES, revisionId, title, kind, position });

interface World {
  readings: ReadingList;
  positions: unknown[];
  pdfAnswers: number[];
  contentCalls: number;
  failPut: boolean;
  /** Answer every position save with 409 `class_archived`. */
  archived?: boolean;
  /** The native reading's HTML as the server sends it now. */
  html: string;
}

function makeWorld(readings: ReadingList): World {
  return { readings, positions: [], pdfAnswers: [], contentCalls: 0, failPut: false, html: HTML };
}

/** The HTTP boundary for the Reading tab: session, topics, readings, content and positions. */
function api(world: World, me = makeMe({ classes: [studentIn(CLASS_A, 'Class A')] })) {
  return stubApi((url, init) => {
    if (url === '/api/me') return { status: 200, body: me };
    if (url === `/api/classes/${CLASS_A}/topics`) return { status: 200, body: makeTopics() };
    if (url === `/api/classes/${CLASS_A}/topics/${T_SAMPLING}/readings`) {
      return { status: 200, body: world.readings };
    }
    if (url === `/api/classes/${CLASS_A}/resources/${RES}/annotations`) {
      // The margin of the reading: nothing noted yet (its own behaviour is tested in margin/).
      return { status: 200, body: { annotations: [], threads: [] } };
    }
    if (url === `/api/classes/${CLASS_A}/positions` && init?.method === 'PUT') {
      if (world.failPut) return { status: 503, body: { error: 'down' } };
      if (world.archived) return { status: 409, body: { error: 'class_archived' } };
      const body = JSON.parse(String(init.body)) as { revisionId: string; position: never };
      world.positions.push(body);
      // The server answers with what it now holds: the reading's list reflects it on reload.
      world.readings = {
        lastRevisionId: body.revisionId,
        readings: world.readings.readings.map((r) =>
          r.revisionId === body.revisionId ? { ...r, position: body.position } : r,
        ),
      };
      return { status: 200, body: { updatedAt: '2026-10-01T09:00:00Z' } };
    }
    if (url === `/api/classes/${CLASS_A}/resources/${REV_NATIVE}/reading`) {
      return {
        status: 200,
        body: {
          revisionId: REV_NATIVE,
          title: 'Why samples vary',
          kind: 'native',
          status: 'ready',
          error: null,
          sourceKey: null,
          html: world.html,
          pdf: null,
        },
      };
    }
    if (url === `/api/classes/${CLASS_A}/resources/${REV_PDF}/reading`) {
      world.contentCalls++;
      return {
        status: 200,
        body: {
          revisionId: REV_PDF,
          title: 'Sampling paper',
          kind: 'pdf',
          status: 'ready',
          error: null,
          sourceKey: SOURCE_KEY,
          html: null,
          pdf: {
            url: world.contentCalls > 1 ? `${PDF_URL}-renewed` : PDF_URL,
            expiresAt: '2026-10-01T09:05:00Z',
            pageCount: 3,
          },
        },
      };
    }
    if (url === `/api/classes/${CLASS_A}/resources/${REV_FAILED}/reading`) {
      return {
        status: 200,
        body: {
          revisionId: REV_FAILED,
          title: 'Broken notes',
          kind: 'native',
          status: 'failed',
          error: 'The file could not be read',
          sourceKey: SOURCE_KEY,
          html: null,
          pdf: null,
        },
      };
    }
    if (
      url ===
      `/api/classes/${CLASS_A}/resources/${REV_FAILED}/objects/${encodeURIComponent(SOURCE_KEY)}?disposition=attachment`
    ) {
      return {
        status: 200,
        body: { url: DOWNLOAD_URL, expiresAt: '2026-10-01T09:05:00Z' },
      };
    }
    if (
      url ===
      `/api/classes/${CLASS_A}/resources/${REV_PDF}/objects/${encodeURIComponent(SOURCE_KEY)}?disposition=attachment`
    ) {
      return {
        status: 200,
        body: { url: DOWNLOAD_URL, expiresAt: '2026-10-01T09:05:00Z' },
      };
    }
    if (url === `/api/classes/${CLASS_A}/resources/${REV_PENDING}/reading`) {
      return {
        status: 200,
        body: {
          revisionId: REV_PENDING,
          title: 'Still converting',
          kind: 'native',
          status: 'pending',
          error: null,
          sourceKey: null,
          html: null,
          pdf: null,
        },
      };
    }
    if (url.startsWith('http://localhost:3100/content/')) {
      const status = world.pdfAnswers.shift() ?? 200;
      return { status, body: status === 200 ? {} : undefined };
    }
    return { status: 404, body: {} };
  });
}

/** jsdom has no layout: block positions come from a table the test moves like a scroll. */
const layout = { tops: {} as Record<string, number>, height: 100 };
const scrollTo = vi.fn();

beforeEach(() => {
  layout.tops = { 'b-title': 0, 'b-one': 60, 'b-two': 160, 'b-code': 260 };
  scrollTo.mockClear();
  vi.stubGlobal('scrollTo', scrollTo);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const id = this.getAttribute('data-block-id');
    const top = id ? (layout.tops[id] ?? 0) : (layout.tops.sheet ?? 0);
    return { top, bottom: top + layout.height, height: layout.height } as DOMRect;
  });
  openPdf.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A reader scrolling: input first (only a reader's scrolling moves the place), then the scroll. */
const scrollThrough = (tops: Record<string, number>) => {
  window.dispatchEvent(new Event('wheel'));
  layout.tops = tops;
  window.dispatchEvent(new Event('scroll'));
};

const putsOf = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');

/** A document whose draws finish at once, or only when the test releases them. */
function pdfDocument(options: { hold?: boolean } = {}) {
  const rendered: number[] = [];
  const cancelled: number[] = [];
  const running: { n: number; settle: (done: boolean) => void }[] = [];
  const doc: PdfDocument = {
    pageCount: 3,
    pageRatio: async () => 3 / 4,
    renderPage: vi.fn((n: number) => {
      // pdf.js refuses a second render on a canvas that is busy.
      if (running.length > 0)
        throw new Error('Cannot use the same canvas during multiple render()');
      rendered.push(n);
      let settle: (done: boolean) => void = () => {};
      const done = new Promise<{ width: number; height: number } | null>((resolve) => {
        settle = (finished) => {
          running.splice(
            running.findIndex((r) => r.n === n),
            1,
          );
          resolve(finished ? { width: 600, height: 800 } : null);
        };
      });
      running.push({ n, settle });
      if (!options.hold) queueMicrotask(() => settle(true));
      return {
        done,
        cancel: () => {
          cancelled.push(n);
          queueMicrotask(() => settle(false));
        },
      };
    }),
    destroy: vi.fn(),
  };
  return Object.assign(doc, { rendered, cancelled, running });
}

describe('empty category', () => {
  it('tells a student that no reading has been added and offers nothing to add', async () => {
    api(makeWorld({ readings: [], lastRevisionId: null }));
    renderApp(READING);
    expect(await screen.findByText('No reading has been added')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Add reading' })).toBeNull();
  });

  it('offers an instructor Add reading', async () => {
    api(
      makeWorld({ readings: [], lastRevisionId: null }),
      makeMe({
        classes: [instructorIn(CLASS_A, 'Class A')],
        courses: [
          {
            courseId: COURSE,
            title: 'Statistical thinking',
            owner: false,
            editor: true,
            publisher: false,
          },
        ],
      }),
    );
    renderApp(READING);
    expect(await screen.findByText('No reading has been added')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Add reading' })).toBeVisible();
  });

  it('offers no Add reading to an instructor who cannot edit the course', async () => {
    api(
      makeWorld({ readings: [], lastRevisionId: null }),
      makeMe({ classes: [instructorIn(CLASS_A, 'Class A')] }),
    );
    renderApp(READING);
    expect(await screen.findByText('No reading has been added')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Add reading' })).toBeNull();
  });
});

describe('native reading', () => {
  const two = (position: ReadingList['readings'][number]['position'] = null): ReadingList => ({
    lastRevisionId: null,
    readings: [
      summary(REV_NATIVE, 'Why samples vary', 'native', position),
      summary(REV_PDF, 'Sampling paper', 'pdf'),
    ],
  });

  it('A03 renders the ingested HTML in the reading measure with its code', async () => {
    api(makeWorld(two()));
    renderApp(READING);
    expect(await screen.findByText('Every sample tells a slightly different story.')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Why samples vary' })).toBeVisible();
    expect(screen.getByText('print(1)').closest('pre')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Reading' })).toHaveValue(REV_NATIVE);
  });

  it('A03 restores the saved place: the block and the share of its text before the offset', async () => {
    api(makeWorld(two({ blockId: 'b-two', offset: 20 })));
    renderApp(READING);
    await screen.findByText('Wider samples vary less than narrow ones do.');
    // b-two sits 160 px down and is 100 px tall; 20 of its 43 characters is 46 % through it.
    const length = 'Wider samples vary less than narrow ones do.'.length;
    expect(scrollTo).toHaveBeenCalledWith({ top: 160 + (20 / length) * 100 });
  });

  it('A03 a scroll the page makes by itself neither overwrites the saved place nor is saved', async () => {
    const world = makeWorld(two({ blockId: 'b-two', offset: 0 }));
    const fetchMock = api(world);
    renderApp(READING);
    await screen.findByText('Wider samples vary less than narrow ones do.');
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    scrollTo.mockClear();
    // The router's scroll to the top after a navigation: no reader input came before it.
    layout.tops = { 'b-title': 0, 'b-one': 60, 'b-two': 160, 'b-code': 260 };
    window.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(putsOf(fetchMock)).toHaveLength(0);
    expect(scrollTo).toHaveBeenCalledWith({ top: 160 });
  });

  it('A03 a reader who drags the scrollbar, which sends no input event, is followed once the hold ends', async () => {
    const world = makeWorld(two({ blockId: 'b-two', offset: 0 }));
    const fetchMock = api(world);
    renderApp(READING);
    await screen.findByText('Wider samples vary less than narrow ones do.');
    const now = performance.now();
    vi.spyOn(performance, 'now').mockReturnValue(now + 5000);
    layout.tops = { 'b-title': -460, 'b-one': -400, 'b-two': -300, 'b-code': -50 };
    scrollTo.mockClear();
    window.dispatchEvent(new Event('scroll'));
    await waitFor(() => expect(putsOf(fetchMock)).toHaveLength(1));
    expect(scrollTo).not.toHaveBeenCalled();
    expect((world.positions[0] as { position: { blockId: string } }).position.blockId).toBe(
      'b-code',
    );
  });

  it('A03 saves the place a reader pauses at and writes it into the address', async () => {
    const world = makeWorld(two());
    const fetchMock = api(world);
    const { router } = renderApp(READING);
    await screen.findByText('Every sample tells a slightly different story.');
    scrollThrough({ 'b-title': -120, 'b-one': -60, 'b-two': 40, 'b-code': 140 });
    await waitFor(() => expect(putsOf(fetchMock)).toHaveLength(1));
    // b-one's bottom (40) is still on screen and the top is 60 px, 60 % of its height, above it.
    const length = 'Every sample tells a slightly different story.'.length;
    expect(world.positions).toEqual([
      {
        revisionId: REV_NATIVE,
        tab: 'reading',
        position: { blockId: 'b-one', offset: Math.round(length * 0.6) },
      },
    ]);
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        resource: REV_NATIVE,
        block: 'b:b-one',
      }),
    );
  });

  it('A03 keeps the place across Reading → Slides → Reading and after a reload', async () => {
    const user = userEvent.setup();
    const world = makeWorld(two());
    api(world);
    const first = renderApp(READING);
    await screen.findByText('Every sample tells a slightly different story.');
    scrollThrough({ 'b-title': -300, 'b-one': -240, 'b-two': -140, 'b-code': -40 });
    await waitFor(() => expect(world.positions).toHaveLength(1));
    const saved = world.positions[0] as { position: { blockId: string; offset: number } };
    expect(saved.position.blockId).toBe('b-code');

    await user.click(screen.getByRole('tab', { name: 'Slides' }));
    await waitFor(() => expect(first.router.state.location.pathname).toMatch(/\/slides$/));
    scrollTo.mockClear();
    layout.tops = { 'b-title': 0, 'b-one': 60, 'b-two': 160, 'b-code': 260 };
    await user.click(screen.getByRole('tab', { name: 'Reading' }));
    await screen.findByText('Every sample tells a slightly different story.');
    expect(scrollTo).toHaveBeenCalledWith({ top: 260 + (saved.position.offset / 8) * 100 });

    // A reload is a new app on the same address and the server's copy.
    first.unmount();
    scrollTo.mockClear();
    renderApp(READING);
    await screen.findByText('Every sample tells a slightly different story.');
    expect(scrollTo).toHaveBeenCalledWith({ top: 260 + (saved.position.offset / 8) * 100 });
  });

  it('A03 reaching the tab row above the reading records no place and the last place is kept', async () => {
    const user = userEvent.setup();
    const world = makeWorld(two());
    const fetchMock = api(world);
    const { router } = renderApp(READING);
    await screen.findByText('Every sample tells a slightly different story.');
    scrollThrough({ 'b-title': -300, 'b-one': -240, 'b-two': -140, 'b-code': -40 });
    await waitFor(() => expect(world.positions).toHaveLength(1));
    // The reader scrolls up to the tab row: the reading starts below the window top.
    scrollThrough({ 'b-title': 400, 'b-one': 460, 'b-two': 560, 'b-code': 660 });
    await user.click(screen.getByRole('tab', { name: 'Slides' }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/slides$/));
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(putsOf(fetchMock)).toHaveLength(1);
    expect((world.positions[0] as { position: { blockId: string } }).position.blockId).toBe(
      'b-code',
    );
  });

  it('A03 Back returns to the reading and place the earlier entry showed', async () => {
    const user = userEvent.setup();
    api(makeWorld(two({ blockId: 'b-one', offset: 0 })));
    const { router } = renderApp(READING);
    await screen.findByText('Every sample tells a slightly different story.');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Reading' }), REV_PDF);
    await waitFor(() => expect(router.state.location.search).toMatchObject({ resource: REV_PDF }));
    openPdf.mockResolvedValue(pdfDocument());
    expect(await screen.findByText('Page 1 of 3')).toBeVisible();

    router.history.back();
    expect(await screen.findByText('Every sample tells a slightly different story.')).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Reading' })).toHaveValue(REV_NATIVE);
  });

  it('A03 Back to an entry opened without a reading returns to the reading it showed', async () => {
    const user = userEvent.setup();
    // Studied last: the PDF. The address names nothing, so the PDF is shown and pinned.
    const world = makeWorld({ ...two(), lastRevisionId: REV_PDF });
    api(world);
    openPdf.mockResolvedValue(pdfDocument());
    const { router } = renderApp(READING);
    expect(await screen.findByText('Page 1 of 3')).toBeVisible();
    await waitFor(() => expect(router.state.location.search).toMatchObject({ resource: REV_PDF }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Reading' }), REV_NATIVE);
    await screen.findByText('Every sample tells a slightly different story.');
    scrollThrough({ 'b-title': -50, 'b-one': 10, 'b-two': 110, 'b-code': 210 });
    // The acknowledged save makes the native reading "the one studied last" in the cache.
    await waitFor(() => expect(world.positions).toHaveLength(1));
    router.history.back();
    expect(await screen.findByText('Page 1 of 3')).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Reading' })).toHaveValue(REV_PDF);
  });

  it('A03 a save that fails is retried by the next move and nothing claims it was kept', async () => {
    const world = makeWorld(two());
    world.failPut = true;
    const fetchMock = api(world);
    renderApp(READING);
    await screen.findByText('Every sample tells a slightly different story.');
    scrollThrough({ 'b-title': -50, 'b-one': 10, 'b-two': 110, 'b-code': 210 });
    await waitFor(() => expect(putsOf(fetchMock)).toHaveLength(1));
    world.failPut = false;
    scrollThrough({ 'b-title': -50, 'b-one': 10, 'b-two': 110, 'b-code': 210 });
    await waitFor(() => expect(world.positions).toHaveLength(1));
    expect(screen.queryByText(/saved/i)).toBeNull();
  });

  it('a place whose save failed offline is sent again when the connection returns', async () => {
    const world = makeWorld(two());
    world.failPut = true;
    const fetchMock = api(world);
    renderApp(READING);
    await screen.findByText('Every sample tells a slightly different story.');
    scrollThrough({ 'b-title': -50, 'b-one': 10, 'b-two': 110, 'b-code': 210 });
    await waitFor(() => expect(putsOf(fetchMock)).toHaveLength(1));
    world.failPut = false;
    window.dispatchEvent(new Event('online'));
    await waitFor(() => expect(world.positions).toHaveLength(1));
    expect(world.positions[0]).toMatchObject({ revisionId: REV_NATIVE });
  });

  it('an older save that fails after a newer one was sent is not resent over it', async () => {
    const world = makeWorld(two());
    const fetchMock = api(world);
    const base = fetchMock.getMockImplementation();
    if (!base) throw new Error('no fetch stub');
    let failA: (() => void) | undefined;
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method !== 'PUT') return base(input, init);
      // Save A waits to fail; save B (sent when the page is hidden) goes through.
      if (!failA) {
        return new Promise<Response>((_resolve, reject) => {
          failA = () => reject(new TypeError('offline'));
        });
      }
      return base(input, init);
    });
    renderApp(READING);
    await screen.findByText('Every sample tells a slightly different story.');
    scrollThrough({ 'b-title': -120, 'b-one': -60, 'b-two': 40, 'b-code': 140 });
    await waitFor(() => expect(putsOf(fetchMock)).toHaveLength(1));
    // A newer place, sent at once because the page is hidden while A is still in flight.
    scrollThrough({ 'b-title': -300, 'b-one': -240, 'b-two': -140, 'b-code': -40 });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(world.positions).toHaveLength(1));
    // A fails after B has gone through; the connection then returns.
    failA?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    window.dispatchEvent(new Event('online'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(putsOf(fetchMock)).toHaveLength(2);
    expect(world.positions).toHaveLength(1);
    expect(world.positions[0]).toMatchObject({ position: { blockId: 'b-code' } });
  });

  it('sends no more position saves once the class is archived, not on a move and not when back online', async () => {
    const world = makeWorld(two());
    world.archived = true;
    const fetchMock = api(world);
    renderApp(READING);
    await screen.findByText('Every sample tells a slightly different story.');
    scrollThrough({ 'b-title': -120, 'b-one': -60, 'b-two': 40, 'b-code': 140 });
    await waitFor(() => expect(putsOf(fetchMock)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    scrollThrough({ 'b-title': -300, 'b-one': -240, 'b-two': -140, 'b-code': -40 });
    window.dispatchEvent(new Event('online'));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(putsOf(fetchMock)).toHaveLength(1);
  });

  it('A01 a place still waiting when access ends is not sent', async () => {
    const world = makeWorld(two());
    const me = makeMe({ classes: [studentIn(CLASS_A, 'Class A')] });
    const fetchMock = api(world, me);
    const { queryClient } = renderApp(READING);
    await screen.findByText('Every sample tells a slightly different story.');
    // A place is reported, and the session loses the class before the pause has passed.
    scrollThrough({ 'b-title': -50, 'b-one': 10, 'b-two': 110, 'b-code': 210 });
    me.classes = [];
    await act(() => queryClient.refetchQueries({ queryKey: ['session'] }));
    expect(
      await screen.findByRole('heading', { name: 'Your access to this class has ended' }),
    ).toBeVisible();
    await act(() => new Promise((r) => setTimeout(r, 500)));
    expect(putsOf(fetchMock)).toHaveLength(0);
  });

  it('A03 says a reading is still being prepared instead of showing it empty', async () => {
    api(
      makeWorld({
        lastRevisionId: null,
        readings: [summary(REV_PENDING, 'Still converting', 'native')],
      }),
    );
    renderApp(READING);
    expect(await screen.findByText('Still converting is being prepared')).toBeVisible();
  });
});

describe('PDF reading', () => {
  const pdfList = (position: ReadingList['readings'][number]['position'] = null): ReadingList => ({
    lastRevisionId: REV_PDF,
    readings: [summary(REV_PDF, 'Sampling paper', 'pdf', position)],
  });

  it('A03 shows the page indicator and page controls and opens at the saved page', async () => {
    const doc = pdfDocument();
    openPdf.mockResolvedValue(doc);
    api(makeWorld(pdfList({ page: 2, offset: 500 })));
    renderApp(READING);
    expect(await screen.findByText('Page 2 of 3')).toBeVisible();
    await waitFor(() => expect(doc.rendered).toContain(2));
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled();
    // The sheet is 100 px tall in this layout: half of it is above the window top.
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 50 }));
  });

  it('A03 clicking Next page while a page is still drawing cancels that draw instead of failing', async () => {
    const user = userEvent.setup();
    const doc = pdfDocument({ hold: true });
    openPdf.mockResolvedValue(doc);
    api(makeWorld(pdfList()));
    renderApp(READING);
    expect(await screen.findByText('Page 1 of 3')).toBeVisible();
    await waitFor(() => expect(doc.rendered).toEqual([1]));
    // Page 1 is still being drawn: two quick clicks ask for page 3 on the same canvas.
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('Page 3 of 3');
    await waitFor(() => expect(doc.cancelled).toContain(1));
    // The newer draw starts only once the older has settled, and the viewer stays up.
    await waitFor(() => expect(doc.rendered).toContain(3));
    expect(screen.queryByRole('alert')).toBeNull();
    doc.running[0]?.settle(true);
    await waitFor(() => expect(doc.running).toHaveLength(0));
    expect(screen.queryByText('This PDF could not be loaded.')).toBeNull();
  });

  it('A03 the page controls move through the document and save the new page', async () => {
    const user = userEvent.setup();
    const doc = pdfDocument();
    openPdf.mockResolvedValue(doc);
    const world = makeWorld(pdfList());
    api(world);
    renderApp(READING);
    expect(await screen.findByText('Page 1 of 3')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Page 2 of 3')).toBeVisible();
    await waitFor(() => expect(doc.rendered).toContain(2));
    await waitFor(() =>
      expect(world.positions).toEqual([
        { revisionId: REV_PDF, tab: 'reading', position: { page: 2, offset: 0 } },
      ]),
    );
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('A03 a scroll that leaves the window top above the page records no place', async () => {
    const doc = pdfDocument();
    openPdf.mockResolvedValue(doc);
    const world = makeWorld(pdfList({ page: 2, offset: 500 }));
    const fetchMock = api(world);
    renderApp(READING);
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 50 }));
    await new Promise((resolve) => setTimeout(resolve, 450));
    // Scrolled up to the tab row: the page starts 300 px below the window top.
    window.dispatchEvent(new Event('wheel'));
    layout.tops = { sheet: 300 };
    window.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(putsOf(fetchMock)).toHaveLength(0);
    // Back inside the page, the place follows the reader again.
    window.dispatchEvent(new Event('wheel'));
    layout.tops = { sheet: -50 };
    window.dispatchEvent(new Event('scroll'));
    await waitFor(() =>
      expect(world.positions.at(-1)).toMatchObject({ position: { page: 2, offset: 500 } }),
    );
  });

  it('A03 fetches the file once more with a renewed link when the first one fails', async () => {
    openPdf.mockResolvedValue(pdfDocument());
    const world = makeWorld(pdfList());
    world.pdfAnswers = [404];
    const fetchMock = api(world);
    renderApp(READING);
    expect(await screen.findByText('Page 1 of 3')).toBeVisible();
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.filter((u) => u.startsWith('http://localhost:3100/content/'))).toEqual([
      PDF_URL,
      `${PDF_URL}-renewed`,
    ]);
    // Simple requests only: a header such as Range would need a preflight the origin lacks.
    for (const [u, init] of fetchMock.mock.calls) {
      if (String(u).startsWith('http://localhost:3100/')) expect(init?.headers).toBeUndefined();
    }
  });

  it('A03 offers Try again when the file cannot be loaded even with a renewed link', async () => {
    const user = userEvent.setup();
    openPdf.mockResolvedValue(pdfDocument());
    const world = makeWorld(pdfList());
    world.pdfAnswers = [404, 404];
    api(world);
    renderApp(READING);
    expect(await screen.findByRole('alert')).toHaveTextContent('This PDF could not be loaded.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Page 1 of 3')).toBeVisible();
  });
});

describe('reading source download', () => {
  const assign = vi.fn();
  beforeEach(() => {
    assign.mockClear();
    vi.stubGlobal('location', { ...window.location, assign });
  });

  it('P1-12b a failed reading offers Try again and a Download of its source file', async () => {
    const user = userEvent.setup();
    api(
      makeWorld({
        lastRevisionId: null,
        readings: [summary(REV_FAILED, 'Broken notes', 'native')],
      }),
    );
    renderApp(READING);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Broken notes could not be processed: The file could not be read',
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(DOWNLOAD_URL));
  });

  it('P1-12b a PDF reading has Download beside its page controls', async () => {
    const user = userEvent.setup();
    openPdf.mockResolvedValue(pdfDocument());
    api(
      makeWorld({
        lastRevisionId: null,
        readings: [summary(REV_PDF, 'Sampling paper', 'pdf')],
      }),
    );
    renderApp(READING);
    expect(await screen.findByText('Page 1 of 3')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(DOWNLOAD_URL));
  });

  it('P1-12b a native reading written inline has no Download', async () => {
    api(
      makeWorld({
        lastRevisionId: null,
        readings: [summary(REV_NATIVE, 'Why samples vary', 'native')],
      }),
    );
    renderApp(READING);
    expect(await screen.findByText('Every sample tells a slightly different story.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
  });
});

describe('reading hardening', () => {
  const two = (position: ReadingList['readings'][number]['position'] = null): ReadingList => ({
    lastRevisionId: null,
    readings: [
      summary(REV_NATIVE, 'Why samples vary', 'native', position),
      summary(REV_PDF, 'Sampling paper', 'pdf'),
    ],
  });
  const length = { 'b-one': 46, 'b-code': 8 };

  /** PUTs wait for `release()` while `held` is true. */
  function holdPuts(fetchMock: ReturnType<typeof stubApi>) {
    const base = fetchMock.getMockImplementation();
    if (!base) throw new Error('no fetch stub');
    const gate = { held: true, release: () => {} };
    let opened = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === 'PUT' && gate.held) {
        await opened;
        opened = Promise.resolve();
      }
      return base(input, init);
    });
    return gate;
  }

  it('A03 the place flushed on leaving is sent with keepalive, and Back returns to it', async () => {
    const user = userEvent.setup();
    const world = makeWorld(two());
    const fetchMock = api(world);
    const { router } = renderApp(READING);
    await screen.findByText('Every sample tells a slightly different story.');
    // A pause on b-one: saved, and written into this entry's address.
    scrollThrough({ 'b-title': -120, 'b-one': -60, 'b-two': 40, 'b-code': 140 });
    await waitFor(() => expect(router.state.location.search).toMatchObject({ block: 'b:b-one' }));
    // Reading on to the code, then Slides before the pause has passed.
    scrollThrough({ 'b-title': -300, 'b-one': -240, 'b-two': -140, 'b-code': -40 });
    await user.click(screen.getByRole('tab', { name: 'Slides' }));
    await waitFor(() => expect(world.positions).toHaveLength(2));
    expect(world.positions[1]).toEqual({
      revisionId: REV_NATIVE,
      tab: 'reading',
      position: { blockId: 'b-code', offset: Math.round(length['b-code'] * 0.4) },
    });
    for (const [, init] of putsOf(fetchMock)) expect(init?.keepalive).toBe(true);

    scrollTo.mockClear();
    layout.tops = { 'b-title': 0, 'b-one': 60, 'b-two': 160, 'b-code': 260 };
    router.history.back();
    await screen.findByText('Every sample tells a slightly different story.');
    // The address holds what the reader sees: the place flushed on leaving.
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        block: 'b:b-code',
        offset: Math.round(length['b-code'] * 0.4),
      }),
    );
    expect(scrollTo).toHaveBeenCalledWith({ top: 260 + (3 / length['b-code']) * 100 });
  });

  it('A03 saves go one at a time: a place reached meanwhile waits, and only the newest is sent', async () => {
    const world = makeWorld(two());
    const fetchMock = api(world);
    const gate = holdPuts(fetchMock);
    renderApp(READING);
    await screen.findByText('Every sample tells a slightly different story.');
    scrollThrough({ 'b-title': -120, 'b-one': -60, 'b-two': 40, 'b-code': 140 });
    await waitFor(() => expect(putsOf(fetchMock)).toHaveLength(1));
    scrollThrough({ 'b-title': -220, 'b-one': -160, 'b-two': -60, 'b-code': 40 });
    await new Promise((resolve) => setTimeout(resolve, 350));
    scrollThrough({ 'b-title': -300, 'b-one': -240, 'b-two': -140, 'b-code': -40 });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(putsOf(fetchMock)).toHaveLength(1);

    gate.held = false;
    gate.release();
    await waitFor(() => expect(world.positions).toHaveLength(2));
    expect(
      world.positions.map((p) => (p as { position: { blockId: string } }).position.blockId),
    ).toEqual(['b-one', 'b-code']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(putsOf(fetchMock)).toHaveLength(2);
  });

  it('A03 fresh content for the open reading keeps the reader where they are', async () => {
    const world = makeWorld(two({ blockId: 'b-one', offset: 0 }));
    api(world);
    const { queryClient } = renderApp(READING);
    await screen.findByText('Every sample tells a slightly different story.');
    scrollThrough({ 'b-title': -300, 'b-one': -240, 'b-two': -140, 'b-code': -40 });
    await waitFor(() => expect(world.positions).toHaveLength(1));
    scrollTo.mockClear();
    // New image links after the content was refetched: the HTML string changes.
    world.html = `${HTML}<p data-block-id="b-more">A paragraph added at the end.</p>`;
    await queryClient.refetchQueries();
    expect(await screen.findByText('A paragraph added at the end.')).toBeVisible();
    // Not back to b-one, where the reading opened: at most a nudge to the place in view, whose
    // offset was rounded to whole characters (3 of 8 is 37.5 px of b-code's 100).
    for (const [arg] of scrollTo.mock.calls) {
      expect(arg).toEqual({ top: -40 + (3 / length['b-code']) * 100 });
    }
  });

  it('A03 in full screen the place follows the workspace scroll and is restored in it', async () => {
    const world = makeWorld(two({ blockId: 'b-two', offset: 0 }));
    const fetchMock = api(world);
    renderApp(READING);
    await screen.findByText('Wider samples vary less than narrow ones do.');
    const workspace = document.querySelector('main');
    if (!workspace) throw new Error('no workspace');
    const workspaceScroll = vi.fn();
    workspace.scrollTo = workspaceScroll as never;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => workspace,
    });
    try {
      document.dispatchEvent(new Event('fullscreenchange'));
      expect(workspaceScroll).toHaveBeenCalledWith({ top: 160 });

      window.dispatchEvent(new Event('wheel'));
      layout.tops = { 'b-title': -300, 'b-one': -240, 'b-two': -140, 'b-code': -40 };
      workspace.dispatchEvent(new Event('scroll'));
      await waitFor(() => expect(world.positions).toHaveLength(1));
      expect(world.positions[0]).toMatchObject({ position: { blockId: 'b-code' } });
      expect(putsOf(fetchMock)).toHaveLength(1);
    } finally {
      Reflect.deleteProperty(document, 'fullscreenElement');
    }
  });

  it('A03 the reading HTML is sanitised again in the browser before it is shown', async () => {
    const world = makeWorld(two());
    world.html = `${HTML}<p data-block-id="b-x" onclick="alert(1)" style="position:fixed">Extra</p><img src="x" onerror="alert(1)">`;
    api(world);
    renderApp(READING);
    const extra = await screen.findByText('Extra');
    expect(extra).toHaveAttribute('data-block-id', 'b-x');
    expect(extra).not.toHaveAttribute('onclick');
    expect(extra).not.toHaveAttribute('style');
    expect(document.querySelector('img[onerror]')).toBeNull();
  });

  it('A03 after Try again the PDF page width follows the stage again', async () => {
    const observed: { target: Element; callback: () => void }[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly callback: () => void) {}
        observe(target: Element) {
          observed.push({ target, callback: this.callback });
        }
        disconnect() {}
      },
    );
    const user = userEvent.setup();
    const doc = pdfDocument();
    openPdf.mockResolvedValue(doc);
    const world = makeWorld({
      lastRevisionId: REV_PDF,
      readings: [summary(REV_PDF, 'Sampling paper', 'pdf')],
    });
    world.pdfAnswers = [404, 404];
    api(world);
    renderApp(READING);
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Page 1 of 3')).toBeVisible();
    const stage = screen.getByRole('navigation', { name: 'PDF pages' }).parentElement;
    const watching = observed.find((o) => o.target === stage);
    expect(watching).toBeDefined();
    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 480 });
    watching?.callback();
    await waitFor(() => expect(doc.renderPage).toHaveBeenLastCalledWith(1, expect.anything(), 480));
  });

  it('A03 other tabs open at the top; only arriving at Reading keeps the scroll for the reader', async () => {
    const user = userEvent.setup();
    api(makeWorld(two()));
    renderApp(READING);
    await screen.findByText('Every sample tells a slightly different story.');
    const reset = () =>
      scrollTo.mock.calls.filter(([arg]) => (arg as { left?: number }).left === 0).length;
    scrollTo.mockClear();
    await user.click(screen.getByRole('tab', { name: 'Exercises' }));
    await waitFor(() => expect(reset()).toBeGreaterThan(0));
    scrollTo.mockClear();
    await user.click(screen.getByRole('tab', { name: 'Reading' }));
    await screen.findByText('Every sample tells a slightly different story.');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reset()).toBe(0);
  });

  it('A03 a place in an address without a reading stays in the address once the reading is added', async () => {
    api(makeWorld(two()));
    const { router } = renderApp(`${READING}?block=b:b-two&offset=5`);
    await screen.findByText('Wider samples vary less than narrow ones do.');
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        resource: REV_NATIVE,
        block: 'b:b-two',
        offset: 5,
      }),
    );
  });

  it('A03 entering full screen redraws the PDF page at the new width and keeps the share of it', async () => {
    const observed: { target: Element; callback: () => void }[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly callback: () => void) {}
        observe(target: Element) {
          observed.push({ target, callback: this.callback });
        }
        disconnect() {}
      },
    );
    const doc = pdfDocument();
    openPdf.mockResolvedValue(doc);
    api(
      makeWorld({
        lastRevisionId: REV_PDF,
        readings: [summary(REV_PDF, 'Sampling paper', 'pdf', { page: 2, offset: 500 })],
      }),
    );
    renderApp(READING);
    expect(await screen.findByText('Page 2 of 3')).toBeVisible();
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 50 }));
    const workspace = document.querySelector('main');
    const stage = screen.getByRole('navigation', { name: 'PDF pages' }).parentElement;
    if (!workspace || !stage) throw new Error('no workspace');
    const workspaceScroll = vi.fn();
    workspace.scrollTo = workspaceScroll as never;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => workspace,
    });
    try {
      document.dispatchEvent(new Event('fullscreenchange'));
      // The sheet is taller once drawn wider: the share is applied again after the redraw.
      layout.height = 160;
      Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 900 });
      for (const o of observed.filter((x) => x.target === stage)) o.callback();
      await waitFor(() =>
        expect(doc.renderPage).toHaveBeenLastCalledWith(2, expect.anything(), 900),
      );
      await waitFor(() => expect(workspaceScroll).toHaveBeenLastCalledWith({ top: 80 }));
    } finally {
      Reflect.deleteProperty(document, 'fullscreenElement');
      layout.height = 100;
    }
  });

  it('A03 hiding the page sends the place at once, and a place waiting behind a save with it', async () => {
    const world = makeWorld(two());
    const fetchMock = api(world);
    holdPuts(fetchMock);
    renderApp(READING);
    await screen.findByText('Every sample tells a slightly different story.');
    scrollThrough({ 'b-title': -120, 'b-one': -60, 'b-two': 40, 'b-code': 140 });
    await waitFor(() => expect(putsOf(fetchMock)).toHaveLength(1));
    // Paused again while the first save is still in flight: this place waits behind it.
    scrollThrough({ 'b-title': -220, 'b-one': -160, 'b-two': -60, 'b-code': 40 });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(putsOf(fetchMock)).toHaveLength(1);
    // The tab is hidden (a phone switching apps): the waiting place leaves now, with keepalive.
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      expect(putsOf(fetchMock)).toHaveLength(2);
      const [, init] = putsOf(fetchMock)[1] ?? [];
      expect(init?.keepalive).toBe(true);
      expect(JSON.parse(String(init?.body))).toMatchObject({ position: { blockId: 'b-two' } });
      // A place still in its pause when the tab is hidden also leaves at once.
      scrollThrough({ 'b-title': -300, 'b-one': -240, 'b-two': -140, 'b-code': -40 });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(putsOf(fetchMock)).toHaveLength(3);
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
    }
  });

  it('A03 a pause in a later visit to the reading keeps Back to the earlier entry on its flushed place', async () => {
    const user = userEvent.setup();
    const world = makeWorld(two());
    api(world);
    const { router } = renderApp(READING);
    await screen.findByText('Every sample tells a slightly different story.');
    // Entry 1: a pause on b-one, then on to the code and Slides before the next pause.
    scrollThrough({ 'b-title': -120, 'b-one': -60, 'b-two': 40, 'b-code': 140 });
    await waitFor(() => expect(router.state.location.search).toMatchObject({ block: 'b:b-one' }));
    scrollThrough({ 'b-title': -300, 'b-one': -240, 'b-two': -140, 'b-code': -40 });
    await user.click(screen.getByRole('tab', { name: 'Slides' }));
    await waitFor(() => expect(world.positions).toHaveLength(2));
    // Entry 3: Reading again, a pause somewhere else.
    await user.click(screen.getByRole('tab', { name: 'Reading' }));
    await screen.findByText('Every sample tells a slightly different story.');
    scrollThrough({ 'b-title': -220, 'b-one': -160, 'b-two': -60, 'b-code': 40 });
    await waitFor(() => expect(router.state.location.search).toMatchObject({ block: 'b:b-two' }));

    layout.tops = { 'b-title': 0, 'b-one': 60, 'b-two': 160, 'b-code': 260 };
    router.history.back();
    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/slides$/));
    scrollTo.mockClear();
    router.history.back();
    await screen.findByText('Every sample tells a slightly different story.');
    // The address holds what the reader sees: the place flushed on leaving.
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        block: 'b:b-code',
        offset: Math.round(length['b-code'] * 0.4),
      }),
    );
    expect(scrollTo).toHaveBeenCalledWith({ top: 260 + (3 / length['b-code']) * 100 });
  });

  it('A03 after fresh content the place is held while late images move the page', async () => {
    const world = makeWorld(two({ blockId: 'b-one', offset: 0 }));
    api(world);
    const { queryClient } = renderApp(READING);
    await screen.findByText('Every sample tells a slightly different story.');
    const now = performance.now();
    vi.spyOn(performance, 'now').mockReturnValue(now + 5000);
    scrollThrough({ 'b-title': -300, 'b-one': -240, 'b-two': -140, 'b-code': -40 });
    await waitFor(() => expect(world.positions).toHaveLength(1));
    world.html = `${HTML}<p data-block-id="b-more">A paragraph added at the end.</p>`;
    await queryClient.refetchQueries();
    await screen.findByText('A paragraph added at the end.');
    scrollTo.mockClear();
    // An image above the reader loads and pushes the text down 50 px; nobody scrolled.
    layout.tops = { 'b-title': -250, 'b-one': -190, 'b-two': -90, 'b-code': 10 };
    window.dispatchEvent(new Event('scroll'));
    expect(scrollTo).toHaveBeenCalledWith({ top: 10 + (3 / length['b-code']) * 100 });
    expect(world.positions).toHaveLength(1);
  });

  it('A03 another element entering full screen leaves the reader where it is', async () => {
    api(makeWorld(two({ blockId: 'b-two', offset: 0 })));
    renderApp(READING);
    await screen.findByText('Wider samples vary less than narrow ones do.');
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    scrollTo.mockClear();
    const other = document.createElement('div');
    document.body.append(other);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => other });
    try {
      document.dispatchEvent(new Event('fullscreenchange'));
      expect(scrollTo).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(document, 'fullscreenElement');
      other.remove();
    }
  });

  it('A03 a PDF redraw after a full screen change keeps the place the reader has reached by then', async () => {
    const observed: { target: Element; callback: () => void }[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly callback: () => void) {}
        observe(target: Element) {
          observed.push({ target, callback: this.callback });
        }
        disconnect() {}
      },
    );
    const doc = pdfDocument();
    openPdf.mockResolvedValue(doc);
    const world = makeWorld({
      lastRevisionId: REV_PDF,
      readings: [summary(REV_PDF, 'Sampling paper', 'pdf', { page: 2, offset: 500 })],
    });
    api(world);
    renderApp(READING);
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 50 }));
    const workspace = document.querySelector('main');
    const stage = screen.getByRole('navigation', { name: 'PDF pages' }).parentElement;
    if (!workspace || !stage) throw new Error('no workspace');
    const workspaceScroll = vi.fn();
    workspace.scrollTo = workspaceScroll as never;
    // The full-screen workspace fills the window: its top is the top of the reading window.
    workspace.getBoundingClientRect = () => ({ top: 0, bottom: 800, height: 800 }) as DOMRect;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => workspace,
    });
    try {
      // Full screen at the same width: nothing is redrawn yet.
      document.dispatchEvent(new Event('fullscreenchange'));
      // The reader reads on to 80 % of the page.
      window.dispatchEvent(new Event('wheel'));
      layout.tops = { sheet: -80 };
      workspace.dispatchEvent(new Event('scroll'));
      await waitFor(() =>
        expect(world.positions.at(-1)).toMatchObject({ position: { page: 2, offset: 800 } }),
      );
      // Later the window is resized and the page redrawn taller: the reader stays at 80 %.
      layout.tops = { sheet: 0 };
      layout.height = 200;
      Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 700 });
      for (const o of observed.filter((x) => x.target === stage)) o.callback();
      await waitFor(() =>
        expect(doc.renderPage).toHaveBeenLastCalledWith(2, expect.anything(), 700),
      );
      await waitFor(() => expect(workspaceScroll).toHaveBeenLastCalledWith({ top: 160 }));
    } finally {
      Reflect.deleteProperty(document, 'fullscreenElement');
      layout.height = 100;
    }
  });

  it('A03 closing the page sends the place waiting behind a save at once, with keepalive', async () => {
    const world = makeWorld(two());
    const fetchMock = api(world);
    holdPuts(fetchMock);
    renderApp(READING);
    await screen.findByText('Every sample tells a slightly different story.');
    scrollThrough({ 'b-title': -120, 'b-one': -60, 'b-two': 40, 'b-code': 140 });
    await waitFor(() => expect(putsOf(fetchMock)).toHaveLength(1));
    scrollThrough({ 'b-title': -220, 'b-one': -160, 'b-two': -60, 'b-code': 40 });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(putsOf(fetchMock)).toHaveLength(1);
    window.dispatchEvent(new Event('pagehide'));
    expect(putsOf(fetchMock)).toHaveLength(2);
    const [, init] = putsOf(fetchMock)[1] ?? [];
    expect(init?.keepalive).toBe(true);
    expect(JSON.parse(String(init?.body))).toMatchObject({ position: { blockId: 'b-two' } });
  });

  it('A03 a pause after a hide flush waits for every save still in flight', async () => {
    const world = makeWorld(two());
    const fetchMock = api(world);
    const base = fetchMock.getMockImplementation();
    if (!base) throw new Error('no fetch stub');
    // Each PUT waits for its own release.
    const releases: Array<() => void> = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === 'PUT') {
        await new Promise<void>((resolve) => releases.push(resolve));
      }
      return base(input, init);
    });
    renderApp(READING);
    await screen.findByText('Every sample tells a slightly different story.');
    scrollThrough({ 'b-title': -120, 'b-one': -60, 'b-two': 40, 'b-code': 140 });
    await waitFor(() => expect(putsOf(fetchMock)).toHaveLength(1));
    // A place waits behind the first save; hiding the tab sends it at once as a second save.
    scrollThrough({ 'b-title': -220, 'b-one': -160, 'b-two': -60, 'b-code': 40 });
    await new Promise((resolve) => setTimeout(resolve, 350));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
    }
    expect(putsOf(fetchMock)).toHaveLength(2);
    // The first save settles; the tab is back and the reader pauses at a third place.
    releases[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    scrollThrough({ 'b-title': -300, 'b-one': -240, 'b-two': -140, 'b-code': -40 });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(putsOf(fetchMock)).toHaveLength(2);
    // Only once the second has settled does the third go.
    releases[1]?.();
    await waitFor(() => expect(putsOf(fetchMock)).toHaveLength(3));
    expect(JSON.parse(String(putsOf(fetchMock)[2]?.[1]?.body))).toMatchObject({
      position: { blockId: 'b-code' },
    });
  });

  it('A03 a later entry that pauses at the same address place does not inherit a flushed place', async () => {
    const world = makeWorld(two());
    api(world);
    const { router } = renderApp(READING);
    await screen.findByText('Every sample tells a slightly different story.');
    // Entry 1: a pause at b-one, then on to the code and Slides within the pause.
    scrollThrough({ 'b-title': -120, 'b-one': -60, 'b-two': 40, 'b-code': 140 });
    await waitFor(() => expect(router.state.location.search).toMatchObject({ block: 'b:b-one' }));
    scrollThrough({ 'b-title': -300, 'b-one': -240, 'b-two': -140, 'b-code': -40 });
    fireEvent.click(screen.getByRole('tab', { name: 'Slides' }));
    await waitFor(() => expect(world.positions).toHaveLength(2));
    // A later entry pauses at the same place b-one, and leaves with nothing pending.
    fireEvent.click(screen.getByRole('tab', { name: 'Reading' }));
    await screen.findByText('Every sample tells a slightly different story.');
    scrollThrough({ 'b-title': -120, 'b-one': -60, 'b-two': 40, 'b-code': 140 });
    await waitFor(() => expect(router.state.location.search).toMatchObject({ block: 'b:b-one' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Slides' }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/slides$/));

    layout.tops = { 'b-title': 0, 'b-one': 60, 'b-two': 160, 'b-code': 260 };
    scrollTo.mockClear();
    router.history.back();
    await screen.findByText('Every sample tells a slightly different story.');
    // Back shows b-one, where that entry paused, not the code.
    expect(router.state.location.search).toMatchObject({ block: 'b:b-one' });
    expect(scrollTo).toHaveBeenCalled();
    for (const [options] of scrollTo.mock.calls) expect(options.top).toBeLessThan(260);
  });

  it("A03 a later entry that pauses at an earlier entry's address place leaves that entry's flushed place", async () => {
    const world = makeWorld(two());
    api(world);
    const { router } = renderApp(READING);
    await screen.findByText('Every sample tells a slightly different story.');
    // Entry 1: a pause at b-one, then on to the code and Slides within the pause.
    scrollThrough({ 'b-title': -120, 'b-one': -60, 'b-two': 40, 'b-code': 140 });
    await waitFor(() => expect(router.state.location.search).toMatchObject({ block: 'b:b-one' }));
    scrollThrough({ 'b-title': -300, 'b-one': -240, 'b-two': -140, 'b-code': -40 });
    fireEvent.click(screen.getByRole('tab', { name: 'Slides' }));
    await waitFor(() => expect(world.positions).toHaveLength(2));
    // A later entry pauses at the same place b-one, and leaves with nothing pending.
    fireEvent.click(screen.getByRole('tab', { name: 'Reading' }));
    await screen.findByText('Every sample tells a slightly different story.');
    scrollThrough({ 'b-title': -120, 'b-one': -60, 'b-two': 40, 'b-code': 140 });
    await waitFor(() => expect(router.state.location.search).toMatchObject({ block: 'b:b-one' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Slides' }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/slides$/));

    layout.tops = { 'b-title': 0, 'b-one': 60, 'b-two': 160, 'b-code': 260 };
    router.history.back();
    await screen.findByText('Every sample tells a slightly different story.');
    // The later entry shows its own pause, b-one.
    expect(router.state.location.search).toMatchObject({ block: 'b:b-one' });
    router.history.back();
    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/slides$/));
    router.history.back();
    await screen.findByText('Every sample tells a slightly different story.');
    // The first entry shows the place flushed as it was left, the code, not b-one.
    await waitFor(() => expect(router.state.location.search).toMatchObject({ block: 'b:b-code' }));
  });
});

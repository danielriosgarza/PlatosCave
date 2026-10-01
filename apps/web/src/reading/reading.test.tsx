import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
const RES = '00000000-0000-4000-8000-000000000401';
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
    if (url === `/api/classes/${CLASS_A}/positions` && init?.method === 'PUT') {
      if (world.failPut) return { status: 503, body: { error: 'down' } };
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
          html: null,
          pdf: {
            url: world.contentCalls > 1 ? `${PDF_URL}-renewed` : PDF_URL,
            expiresAt: '2026-10-01T09:05:00Z',
            pageCount: 3,
          },
        },
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
  it('A03 tells a student that no reading has been added and offers nothing to add', async () => {
    api(makeWorld({ readings: [], lastRevisionId: null }));
    renderApp(READING);
    expect(await screen.findByText('No reading has been added')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Add reading' })).toBeNull();
  });

  it('A03 offers an instructor Add reading', async () => {
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

  it('A03 offers no Add reading to an instructor who cannot edit the course', async () => {
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
    expect(router.state.location.search).toMatchObject({ block: 'b:b-one' });
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
});

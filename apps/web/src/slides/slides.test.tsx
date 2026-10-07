import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PdfDocument } from '../reading/pdfjs';
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
import type { DeckList } from './slides';

const openPdf = vi.hoisted(() => vi.fn());
vi.mock('../reading/pdfjs', () => ({ openPdf }));

const REV_A = '00000000-0000-4000-8000-000000000601';
const REV_B = '00000000-0000-4000-8000-000000000602';
const REV_PENDING = '00000000-0000-4000-8000-000000000603';
const REV_WEB = '00000000-0000-4000-8000-000000000604';
const RES = '00000000-0000-4000-8000-000000000401';
const SOURCE_KEY = `courses/${COURSE}/objects/${'a'.repeat(64)}`;
const DECK_URL = 'http://localhost:3100/content/deck-1';
const SLIDES = `/classes/${CLASS_A}/topics/${T_SAMPLING}/slides`;
const PAGES = 12;
const MAT = { width: 978, height: 550 };
// What ingestion stores for a web deck; the hostile bits are what a second sanitiser must catch.
const WEB_SLIDES = [
  '<h1 data-block-id="a1">Sampling</h1>\n<p data-block-id="a2">Why samples vary</p>',
  '<h2 data-block-id="b1">Two ideas</h2>\n<ul><li data-block-id="b2">the mean moves</li></ul>' +
    '<img alt="x" src="data:image/svg+xml,<svg onload=alert(1)>" onerror="alert(1)"><script>alert(1)</script>',
  '<p data-block-id="c1">Last slide</p>',
];

const deck = (revisionId: string, title: string, page?: number) => ({
  resourceId: RES,
  revisionId,
  title,
  position: page === undefined ? null : { page, offset: 0 },
});

interface World {
  decks: DeckList;
  puts: { revisionId: string; tab: string; position: { page: number; offset: number } }[];
  contentCalls: number;
  /** Answer every position save with 409 `class_archived`. */
  archived?: boolean;
}

function api(world: World, me = makeMe({ classes: [studentIn(CLASS_A, 'Class A')] })) {
  return stubApi((url, init) => {
    if (url === '/api/me') return { status: 200, body: me };
    if (url === `/api/classes/${CLASS_A}/topics`) return { status: 200, body: makeTopics() };
    if (url === `/api/classes/${CLASS_A}/topics/${T_SAMPLING}/slides`) {
      return { status: 200, body: world.decks };
    }
    if (url === `/api/classes/${CLASS_A}/positions` && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as World['puts'][number];
      world.puts.push(body);
      if (world.archived) return { status: 409, body: { error: 'class_archived' } };
      return { status: 200, body: { updatedAt: '2026-10-01T09:00:00Z' } };
    }
    if (url === `/api/classes/${CLASS_A}/resources/${REV_WEB}/slides`) {
      return {
        status: 200,
        body: {
          revisionId: REV_WEB,
          title: 'Sampling slides',
          status: 'ready',
          error: null,
          sourceKey: null,
          pdf: null,
          web: { slides: WEB_SLIDES },
        },
      };
    }
    for (const [revisionId, title, state] of [
      [REV_A, 'Sampling lecture', 'ready'],
      [REV_B, 'Sampling recap', 'ready'],
      [REV_PENDING, 'Still converting', 'pending'],
    ] as const) {
      if (url === `/api/classes/${CLASS_A}/resources/${revisionId}/slides`) {
        world.contentCalls++;
        return {
          status: 200,
          body: {
            revisionId,
            title,
            status: state,
            error: null,
            sourceKey: SOURCE_KEY,
            web: null,
            pdf:
              state === 'ready'
                ? {
                    url: world.contentCalls > 1 ? `${DECK_URL}-renewed` : DECK_URL,
                    expiresAt: '2026-10-01T09:05:00Z',
                    pageCount: PAGES,
                  }
                : null,
          },
        };
      }
    }
    if (url.includes('/objects/')) {
      return { status: 200, body: { url: 'http://localhost:3100/content/download-1' } };
    }
    return { status: 404, body: {} };
  });
}

const makeWorld = (decks: DeckList['decks'], lastRevisionId: string | null = null): World => ({
  decks: { decks, lastRevisionId },
  puts: [],
  contentCalls: 0,
});

/** A deck whose draws finish at once; `rendered` lists the slides and widths it drew. */
function pdfDocument() {
  const rendered: { n: number; width: number }[] = [];
  const doc: PdfDocument = {
    pageCount: PAGES,
    pageRatio: async () => 16 / 9,
    renderPage: vi.fn((n: number, _target, width: number) => {
      rendered.push({ n, width });
      return {
        done: Promise.resolve({ width, height: Math.round((width * 9) / 16) }),
        cancel: () => undefined,
      };
    }),
    destroy: vi.fn(),
  };
  return Object.assign(doc, { rendered });
}

beforeEach(() => {
  openPdf.mockReset();
  // jsdom has no layout: the stage is the size the wireframe gives it at 1440 x 900.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(MAT.width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(MAT.height);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const viewer = () => screen.findByRole('region', { name: 'Slide viewer' });
const position = () => screen.getByText(/^\d+ \/ 12$/);

describe('slide viewer', () => {
  it('opens a deck over its content link, draws one slide fitted to the stage and reports its place', async () => {
    const doc = pdfDocument();
    openPdf.mockResolvedValue(doc);
    api(makeWorld([deck(REV_A, 'Sampling lecture')]));
    renderApp(SLIDES);
    await viewer();
    // The link is opened with range requests (a string, not downloaded bytes) and one slide drawn.
    expect(openPdf).toHaveBeenCalledWith(DECK_URL);
    await waitFor(() => expect(doc.rendered).toHaveLength(1));
    // 16:9 inside 978 x 550 fits by height: 550 x 16/9 = 977, never distorted.
    expect(doc.rendered[0]).toEqual({ n: 1, width: Math.floor(550 * (16 / 9)) });
    expect(position()).toHaveTextContent('1 / 12');
    expect(screen.getByRole('progressbar', { name: 'Slide position' })).toHaveAttribute(
      'aria-valuenow',
      '1',
    );
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  });

  it('A24 repeated arrow presses advance a focused viewer, and focus stays on it', async () => {
    const user = userEvent.setup();
    const doc = pdfDocument();
    openPdf.mockResolvedValue(doc);
    api(makeWorld([deck(REV_A, 'Sampling lecture')]));
    renderApp(SLIDES);
    const stage = await viewer();
    await waitFor(() => expect(doc.rendered).toHaveLength(1));
    stage.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    expect(position()).toHaveTextContent('4 / 12');
    expect(stage).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(position()).toHaveTextContent('3 / 12');
    await waitFor(() => expect(doc.rendered.at(-1)?.n).toBe(3));

    // Using a control moves the slide and keeps the focus on the viewer.
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(position()).toHaveTextContent('4 / 12');
    expect(stage).toHaveFocus();
    // Modified arrows are the browser's.
    await user.keyboard('{Control>}{ArrowRight}{/Control}');
    expect(position()).toHaveTextContent('4 / 12');
  });

  it('A24 arrows change nothing while the viewer does not hold focus', async () => {
    const user = userEvent.setup();
    openPdf.mockResolvedValue(pdfDocument());
    api(makeWorld([deck(REV_A, 'Sampling lecture', 5)]));
    renderApp(SLIDES);
    await viewer();
    expect(position()).toHaveTextContent('5 / 12');
    await user.click(document.body);
    await user.keyboard('{ArrowRight}{ArrowLeft}{ArrowLeft}');
    expect(position()).toHaveTextContent('5 / 12');
  });

  it('A24 a viewer given no notes slot has no Notes control', async () => {
    openPdf.mockResolvedValue(pdfDocument());
    api(makeWorld([deck(REV_A, 'Sampling lecture')]));
    const { SlideViewer } = await import('./SlideViewer');
    const { render } = await import('@testing-library/react');
    render(
      <SlideViewer
        url={DECK_URL}
        pageCount={PAGES}
        initialPage={1}
        source={{ classId: CLASS_A, revisionId: REV_A, key: null }}
        onPage={vi.fn()}
      />,
    );
    await viewer();
    expect(screen.queryByRole('button', { name: 'Notes' })).toBeNull();
  });

  it('A24 the notes slot follows the slide shown and is not reached by arrow keys typed in it', async () => {
    const user = userEvent.setup();
    const doc = pdfDocument();
    openPdf.mockResolvedValue(doc);
    const world = makeWorld([deck(REV_A, 'Sampling lecture')]);
    api(world);
    const { SlideViewer } = await import('./SlideViewer');
    const { render } = await import('@testing-library/react');
    const onPage = vi.fn();
    const renew = vi.fn(async () => null);
    render(
      <SlideViewer
        url={DECK_URL}
        pageCount={PAGES}
        renew={renew}
        initialPage={1}
        source={{ classId: CLASS_A, revisionId: REV_A, key: null }}
        onPage={onPage}
        notes={({ page, revisionId }) => (
          <label>
            Note for slide {page} of {revisionId.slice(-3)}
            <textarea />
          </label>
        )}
      />,
    );
    const stage = await viewer();
    await user.click(screen.getByRole('button', { name: 'Notes' }));
    const margin = screen.getByRole('complementary', { name: 'Slide notes' });
    expect(within(margin).getByLabelText('Note for slide 1 of 601')).toBeVisible();
    stage.focus();
    await user.keyboard('{ArrowRight}');
    expect(within(margin).getByLabelText('Note for slide 2 of 601')).toBeVisible();
    // Typing in a field keeps its arrows.
    await user.type(
      within(margin).getByLabelText('Note for slide 2 of 601'),
      'ab{ArrowLeft}{ArrowRight}',
    );
    expect(position()).toHaveTextContent('2 / 12');
    expect(onPage).toHaveBeenLastCalledWith(2);
    expect(screen.getByRole('button', { name: 'Hide notes' })).not.toHaveAttribute('aria-pressed');
  });

  it('opens at the slide studied last and saves the new one once it settles', async () => {
    const user = userEvent.setup();
    const doc = pdfDocument();
    openPdf.mockResolvedValue(doc);
    const world = makeWorld([deck(REV_A, 'Sampling lecture', 7)], REV_A);
    api(world);
    renderApp(SLIDES);
    const stage = await viewer();
    expect(position()).toHaveTextContent('7 / 12');
    await waitFor(() => expect(doc.rendered.at(-1)?.n).toBe(7));
    stage.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    await waitFor(() => expect(world.puts).toHaveLength(1));
    // One save for the slide it stopped on, bound to the deck revision and the slides tab.
    expect(world.puts[0]).toEqual({
      revisionId: REV_A,
      tab: 'slides',
      position: { page: 9, offset: 0 },
    });
  });

  it('opens at the slide the address names, not at the saved one, and only for the deck it names', async () => {
    const doc = pdfDocument();
    openPdf.mockResolvedValue(doc);
    api(makeWorld([deck(REV_A, 'Sampling lecture', 7), deck(REV_B, 'Sampling recap', 2)], REV_A));
    renderApp(`${SLIDES}?resource=${REV_A}&page=5`);
    await viewer();
    expect(position()).toHaveTextContent('5 / 12');
    await waitFor(() => expect(doc.rendered.at(-1)?.n).toBe(5));
  });

  it('sends no more slide saves once the class is archived, and still opens at the saved slide', async () => {
    const user = userEvent.setup();
    openPdf.mockResolvedValue(pdfDocument());
    const world = makeWorld([deck(REV_A, 'Sampling lecture', 7)], REV_A);
    world.archived = true;
    api(world);
    renderApp(SLIDES);
    const stage = await viewer();
    expect(position()).toHaveTextContent('7 / 12');
    stage.focus();
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(world.puts).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await user.keyboard('{ArrowRight}{ArrowRight}');
    // Longer than the pause after which a place is sent.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(position()).toHaveTextContent('10 / 12');
    expect(world.puts).toHaveLength(1);
  });

  it('jumps from the index, which opens on demand, and keeps the viewer focused', async () => {
    const user = userEvent.setup();
    const doc = pdfDocument();
    openPdf.mockResolvedValue(doc);
    api(makeWorld([deck(REV_A, 'Sampling lecture')]));
    renderApp(SLIDES);
    const stage = await viewer();
    expect(screen.queryByRole('list', { name: 'Slides' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Slide index' }));
    const index = screen.getByRole('list', { name: 'Slides' });
    expect(within(index).getAllByRole('button')).toHaveLength(PAGES);
    await user.click(within(index).getByRole('button', { name: 'Slide 9' }));
    expect(position()).toHaveTextContent('9 / 12');
    expect(within(index).getByRole('button', { name: 'Slide 9' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(stage).toHaveFocus();
  });

  it('zooms over the fitted size and returns to fit', async () => {
    const user = userEvent.setup();
    const doc = pdfDocument();
    openPdf.mockResolvedValue(doc);
    api(makeWorld([deck(REV_A, 'Sampling lecture')]));
    renderApp(SLIDES);
    await viewer();
    await waitFor(() => expect(doc.rendered).toHaveLength(1));
    const fit = doc.rendered[0]?.width ?? 0;
    expect(screen.getByRole('button', { name: 'Fit' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    await waitFor(() => expect(doc.rendered.at(-1)?.width).toBe(Math.floor(550 * (16 / 9) * 1.5)));
    expect(screen.getByText('Zoom 150%')).toHaveAttribute('role', 'status');
    await user.click(screen.getByRole('button', { name: 'Fit' }));
    await waitFor(() => expect(doc.rendered.at(-1)?.width).toBe(fit));
    expect(screen.getByRole('button', { name: 'Fit' })).toBeDisabled();
    expect(screen.queryByText(/^Zoom \d+%$/)).toBeNull();
  });

  it('A04 Focus and Escape keep the slide: the viewer is not rebuilt', async () => {
    const user = userEvent.setup();
    const doc = pdfDocument();
    openPdf.mockResolvedValue(doc);
    api(makeWorld([deck(REV_A, 'Sampling lecture', 4)]));
    renderApp(SLIDES);
    const stage = await viewer();
    await waitFor(() => expect(doc.rendered).toHaveLength(1));
    stage.focus();
    await user.keyboard('{ArrowRight}');
    expect(position()).toHaveTextContent('5 / 12');

    await user.click(screen.getByRole('button', { name: 'Focus' }));
    expect(screen.queryByRole('tablist', { name: 'Topic materials' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Slide viewer' })).toBe(stage);
    expect(position()).toHaveTextContent('5 / 12');
    expect(openPdf).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    expect(screen.getByRole('tablist', { name: 'Topic materials' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Slide viewer' })).toBe(stage);
    expect(position()).toHaveTextContent('5 / 12');
    expect(openPdf).toHaveBeenCalledTimes(1);
  });
});

describe('several decks and states', () => {
  it('picks among decks by title, each with its own slide', async () => {
    const user = userEvent.setup();
    const doc = pdfDocument();
    openPdf.mockResolvedValue(doc);
    api(makeWorld([deck(REV_A, 'Sampling lecture', 3), deck(REV_B, 'Sampling recap', 8)], REV_B));
    renderApp(SLIDES);
    // The deck studied last opens first.
    await viewer();
    expect(position()).toHaveTextContent('8 / 12');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Slides' }), 'Sampling lecture');
    await waitFor(() => expect(position()).toHaveTextContent('3 / 12'));
  });

  it('keeps the deck picker when the deck on show is being prepared or failed', async () => {
    const user = userEvent.setup();
    openPdf.mockResolvedValue(pdfDocument());
    api(makeWorld([deck(REV_PENDING, 'Still converting'), deck(REV_A, 'Sampling lecture')]));
    renderApp(SLIDES);
    expect(await screen.findByText('Still converting is being prepared')).toBeVisible();
    const picker = screen.getByRole('combobox', { name: 'Slides' });
    await user.selectOptions(picker, 'Sampling lecture');
    await viewer();
    expect(position()).toHaveTextContent('1 / 12');
  });

  it('keeps the deck picker when the deck cannot be opened', async () => {
    const user = userEvent.setup();
    openPdf.mockRejectedValueOnce(new Error('bad')).mockRejectedValueOnce(new Error('bad'));
    api(makeWorld([deck(REV_A, 'Sampling lecture'), deck(REV_B, 'Sampling recap')]));
    renderApp(SLIDES);
    expect(await screen.findByRole('alert')).toHaveTextContent('These slides could not be loaded.');
    openPdf.mockResolvedValue(pdfDocument());
    await user.selectOptions(screen.getByRole('combobox', { name: 'Slides' }), 'Sampling recap');
    await viewer();
  });

  it('tells a student that no slides have been added and offers an instructor Add slides', async () => {
    api(makeWorld([]));
    renderApp(SLIDES);
    expect(await screen.findByText('No slides have been added')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Add slides' })).toBeNull();
    cleanup();

    api(
      makeWorld([]),
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
    renderApp(SLIDES);
    expect(await screen.findByRole('link', { name: 'Add slides' })).toBeVisible();
  });

  it('says a deck is being prepared instead of showing an empty stage', async () => {
    api(makeWorld([deck(REV_PENDING, 'Still converting')]));
    renderApp(SLIDES);
    expect(await screen.findByText('Still converting is being prepared')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Slide viewer' })).toBeNull();
  });

  it('offers Try again and the original file when the deck cannot be opened', async () => {
    const user = userEvent.setup();
    openPdf.mockRejectedValueOnce(new Error('bad')).mockRejectedValueOnce(new Error('bad'));
    api(makeWorld([deck(REV_A, 'Sampling lecture')]));
    renderApp(SLIDES);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('These slides could not be loaded.');
    expect(within(alert).getByRole('button', { name: 'Download' })).toBeVisible();
    openPdf.mockResolvedValue(pdfDocument());
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await viewer();
  });

  it('opens the deck again on a new link when a slide fails after the first link expired', async () => {
    const user = userEvent.setup();
    const first = pdfDocument();
    let failing = false;
    const original = first.renderPage;
    first.renderPage = vi.fn((...args: Parameters<typeof original>) => {
      if (failing) {
        return { done: Promise.reject(new Error('expired')), cancel: () => undefined };
      }
      return original(...args);
    });
    const second = pdfDocument();
    openPdf.mockResolvedValueOnce(first).mockResolvedValue(second);
    api(makeWorld([deck(REV_A, 'Sampling lecture')]));
    renderApp(SLIDES);
    const stage = await viewer();
    await waitFor(() => expect(first.rendered).toHaveLength(1));
    failing = true;
    stage.focus();
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(second.rendered.at(-1)?.n).toBe(2));
    expect(openPdf).toHaveBeenCalledTimes(2);
    expect(position()).toHaveTextContent('2 / 12');
  });
});

describe('web slides', () => {
  const count = () => screen.getByText(/^\d+ \/ 3$/);
  const open = async () => {
    const world = makeWorld([deck(REV_WEB, 'Sampling slides', 2)], REV_WEB);
    api(world);
    renderApp(SLIDES);
    const stage = await viewer();
    return { world, stage };
  };
  const box = (n: number) =>
    screen.getByRole('article', { name: `Slide ${n} of 3` }).parentElement as HTMLElement;
  const FIT = Math.floor(550 * (16 / 9));

  it('shows the slide of a web deck in a 16:9 box fitted to the stage, opened at the last slide studied', async () => {
    await open();
    expect(openPdf).not.toHaveBeenCalled();
    expect(count()).toHaveTextContent('2 / 3');
    expect(await screen.findByRole('heading', { name: 'Two ideas' })).toBeVisible();
    // 16:9 inside 978 x 550 fits by height: never distorted.
    expect(box(2).style.width).toBe(`${FIT}px`);
    expect(box(2).style.height).toBe(`${Math.round(FIT / (16 / 9))}px`);
    expect(screen.queryByText('Why samples vary')).toBeNull();
  });

  it('the viewer controls work on a web deck: arrows, index, zoom and fit, and the place is saved', async () => {
    const user = userEvent.setup();
    const { world, stage } = await open();
    stage.focus();
    await user.keyboard('{ArrowRight}');
    expect(count()).toHaveTextContent('3 / 3');
    expect(screen.getByText('Last slide')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(
      within(screen.getByRole('article', { name: 'Slide 1 of 3' })).getByRole('heading', {
        name: 'Sampling',
      }),
    ).toBeVisible();
    expect(stage).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Slide index' }));
    const index = screen.getByRole('list', { name: 'Slides' });
    expect(within(index).getAllByRole('button')).toHaveLength(3);
    await user.click(within(index).getByRole('button', { name: 'Slide 3' }));
    expect(screen.getByText('Last slide')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(box(3).style.width).toBe(`${Math.floor(550 * (16 / 9) * 1.5)}px`);
    await user.click(screen.getByRole('button', { name: 'Fit' }));
    expect(box(3).style.width).toBe(`${FIT}px`);

    await waitFor(() => expect(world.puts.at(-1)?.position).toEqual({ page: 3, offset: 0 }));
    expect(world.puts.at(-1)).toMatchObject({ revisionId: REV_WEB, tab: 'slides' });
  });

  it('inserts no script, handler or data image from a slide', async () => {
    await open();
    const slide = screen.getByRole('article', { name: 'Slide 2 of 3' });
    expect(slide.querySelector('script')).toBeNull();
    expect(slide.innerHTML).not.toMatch(/onerror|onload|alert\(1\)|data:image/i);
    expect(within(slide).getByText('the mean moves')).toBeVisible();
  });
});

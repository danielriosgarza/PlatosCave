import { openCourse, openPaths, openResource, openTopic } from '@parallax/contracts';
import type { AnyRoute } from '@tanstack/react-router';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Link, type PageProps, type Site, type SitePage } from '../sitePages';
import { createOpenApp, mountOpen } from './app';

// `createRoot` as it is, recorded, so that the root `mountOpen` makes can be unmounted.
vi.mock('react-dom/client', { spy: true });

const props: PageProps = {
  site: { name: 'Reef School', entry: '/courses' },
  catalogue: { instructors: [] },
};
/** A page showing its heading, the site's name and a link to the about page. */
const page = (path: string, heading: string): SitePage => ({
  path,
  load: async () => ({
    default: ({ site }: PageProps) => (
      <main id="main">
        <h1>{heading}</h1>
        <p>{site.name}</p>
        <Link to="/about">About</Link>
      </main>
    ),
  }),
});
const about = { props, pages: [page('/about', 'About Ana Lima')] };

/** One topic with two web decks of three slides, each data file through its schema. */
const COURSE = 'reef-ecology';
const [TOPIC, TRANSECTS, QUADRATS, GONE] = [
  '5f0c1d8e-3b7a-4c2e-9a41-7d2f6b0e1c33',
  'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
  '6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d',
  '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e',
];
const NONE = { slides: false, reading: false, exercises: false, notebooks: false, tests: false };
const file = (address: string, schema: { parse(value: unknown): unknown }, value: unknown) =>
  [address, JSON.stringify(schema.parse(value))] as const;
const deck = (id: string, title: string) =>
  file(openPaths.resourceData(COURSE, TOPIC, id), openResource, {
    ...{ type: 'slides', title, pdf: null },
    web: { slides: [1, 2, 3].map((n) => `<h1>${title} ${n}</h1>`) },
  });
const topic = { topicId: TOPIC, number: 1, title: 'Sampling a reef', objective: '' };
const served = new Map([
  file(openPaths.courseData(COURSE), openCourse, {
    ...{ title: 'Reef ecology', instructors: ['Ana Lima'] },
    topics: [{ ...topic, estimatedMinutes: null, presence: NONE, firstTab: null }],
  }),
  file(openPaths.topicData(COURSE, TOPIC), openTopic, {
    slides: [
      { resourceId: TRANSECTS, title: 'Transects' },
      { resourceId: QUADRATS, title: 'Quadrats' },
    ],
    ...{ reading: [], notebooks: [], exercises: [], tests: [] },
  }),
  deck(TRANSECTS, 'Transects'),
  deck(QUADRATS, 'Quadrats'),
]);
const slides = openPaths.topic(COURSE, TOPIC, 'slides');

/** Every request the shell made: `fetch` serves the data files above and records each call. */
let requests: { url: string; method: string; credentials?: RequestCredentials }[] = [];
function record() {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET', credentials: init?.credentials });
    const body = served.get(url);
    return body === undefined ? new Response('', { status: 404 }) : new Response(body);
  });
}
function open(address: string, site?: Site) {
  record();
  window.history.replaceState(null, '', address);
  const app = createOpenApp(site);
  render(app.element);
  return app;
}

/** The slide the viewer shows: its heading and its place in the deck. */
async function expectSlide(heading: string, n: number) {
  const viewer = await screen.findByRole('region', { name: 'Slide viewer' });
  expect(await within(viewer).findByRole('heading', { name: heading })).toBeInTheDocument();
  expect(within(viewer).getByRole('progressbar')).toHaveAttribute('aria-valuenow', String(n));
}

let mounted: Root[] = [];
afterEach(() => {
  cleanup();
  for (const root of mounted) act(() => root.unmount());
  mounted = [];
  vi.unstubAllGlobals();
  requests = [];
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('level 0 shell: site pages and addresses', () => {
  test('a site page renders below the bar and / shows the front page, and without one / goes to /courses', async () => {
    const user = userEvent.setup();
    const pages = [page('/', 'Welcome to the reef'), ...about.pages];
    const { router } = open('/', { props, pages });
    expect(await screen.findByRole('heading', { name: 'Welcome to the reef' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
    expect(screen.getByText('Reef School')).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'About' }));
    const heading = await screen.findByRole('heading', { name: 'About Ana Lima' });
    const bar = screen.getByRole('banner');
    expect(within(bar).getByRole('link', { name: 'Courses' })).toHaveAttribute('href', '/courses');
    expect(bar.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(requests).toEqual([]);
    cleanup();

    const without = open('/', about);
    await waitFor(() => expect(without.router.state.location.pathname).toBe('/courses'));
    await waitFor(() => expect(requests.map((r) => r.url)).toEqual([openPaths.catalogue]));
  });

  test('an address with a trailing slash opens the same screen as one without', async () => {
    for (const address of ['/about', '/about/']) {
      open(address, about);
      expect(await screen.findByRole('heading', { name: 'About Ana Lima' })).toBeInTheDocument();
      cleanup();
    }
    const asked: string[][] = [];
    for (const address of [slides, `${slides}/`]) {
      open(address, about);
      await expectSlide('Transects 1', 1);
      expect(screen.getByRole('heading', { name: 'Sampling a reef' })).toBeInTheDocument();
      asked.push(requests.map((r) => r.url).sort());
      requests = [];
      cleanup();
    }
    expect(asked[1]).toEqual(asked[0]);
  });

  test('?page opens a slide of the deck that ?resource names, and of no other', async () => {
    const cases = [
      [`${slides}?resource=${QUADRATS}&page=2`, 'Quadrats 2', 2],
      [`${slides}?resource=${TRANSECTS}&page=3`, 'Transects 3', 3],
      [`${slides}?page=2`, 'Transects 1', 1],
      [`${slides}?resource=${GONE}&page=2`, 'Transects 1', 1],
    ] as const;
    for (const [address, heading, n] of cases) {
      open(address);
      await expectSlide(heading, n);
      cleanup();
    }
  });

  test('a page at /courses/x makes createOpenApp throw and names the address', () => {
    const at = (path: string) => () => createOpenApp({ props, pages: [page(path, 'Taken')] });
    expect(at('/courses/x')).toThrow(
      'The site page /courses/x would be at /courses/$a: Parallax keeps /courses and the addresses below it.',
    );
    for (const path of ['/courses', '/courses/x/y', '/courses/x/y/z/w']) {
      expect(at(path)).toThrow(`The site page ${path} would be at /courses`);
    }
    expect(at('/coursework')).not.toThrow();
  });

  test('a page whose module cannot be fetched shows the route failure and leaves sessionStorage empty', async () => {
    const lost = new TypeError(
      'Failed to fetch dynamically imported module: /assets/about-3f2a.js',
    );
    open('/about', { props, pages: [{ path: '/about', load: () => Promise.reject(lost) }] });
    expect(await screen.findByText('This page could not be shown.')).toBeInTheDocument();
    expect(within(screen.getByRole('banner')).getByRole('link', { name: 'Courses' })).toBeVisible();
    expect(sessionStorage.length).toBe(0);
  });

  test("siteRoutes mounted under the shell's own root, not the generated tree, serves the page", async () => {
    const { router } = createOpenApp(about);
    const byPath = router.routesByPath as Record<string, AnyRoute | undefined>;
    expect(byPath['/about']?.parentRoute).toBe(router.routeTree);

    record();
    window.history.replaceState(null, '', '/about');
    const container = document.body.appendChild(document.createElement('div'));
    act(() => mountOpen(container, about));
    const made = vi.mocked(createRoot).mock;
    mounted = made.results.filter((_, i) => made.calls[i]?.[0] === container).map((r) => r.value);
    const heading = await screen.findByRole('heading', { name: 'About Ana Lima' });
    const bar = screen.getByRole('banner');
    expect(within(bar).getByRole('link', { name: 'Parallax' })).toHaveAttribute('href', '/');
    expect(bar.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The generated tree's root is the application's: its bar asks /api for the session.
    expect(screen.queryByRole('link', { name: /sign in/i })).toBeNull();
    expect(requests).toEqual([]);
    container.remove();
  });
});

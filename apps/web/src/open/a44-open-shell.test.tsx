import { openCourse, openPaths, openResource, openTopic } from '@parallax/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import { createOpenApp } from './app';

// pdf.js needs a canvas and a worker, which jsdom lacks: a PDF deck stays loading.
const openPdf = vi.hoisted(() => vi.fn(() => new Promise(() => {})));
vi.mock('../reading/pdfjs', () => ({ openPdf }));

/** Data files in the shapes the level 0 build writes for "Reef ecology", each through its schema. */
const COURSE = 'reef-ecology';
const [SAMPLING, TIDES, WEB, PDF, READING] = [
  '5f0c1d8e-3b7a-4c2e-9a41-7d2f6b0e1c33',
  '0b2f4a6c-8d1e-4f3a-b5c7-9e0a1b2c3d4e',
  'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
  '6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d',
  '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e',
] as const;
const PDF_URL = `https://content.reef.example.org/o/${'a'.repeat(64)}.pdf`;
const NONE = { slides: false, reading: false, exercises: false, notebooks: false, tests: false };
const SLIDE = '<h1>Transects</h1><p>A line across a reef.</p>';
const TEXT =
  '<h1>Survey methods</h1><p>The density is <span class="katex"><math><mrow><mi>d</mi><mo>=</mo>' +
  '<mfrac><mi>n</mi><mi>a</mi></mfrac></mrow></math></span>.</p>';

function files(slide = SLIDE, html = TEXT) {
  const topics = [
    { topicId: SAMPLING, number: 1, title: 'Sampling a reef', estimatedMinutes: 90 },
    { topicId: TIDES, number: 2, title: 'Tides and zones', estimatedMinutes: null },
  ].map((topic) => ({ ...topic, objective: '', presence: NONE, firstTab: null }));
  const lists = {
    slides: [
      { resourceId: WEB, title: 'Transects' },
      { resourceId: PDF, title: 'Reef zones' },
    ],
    reading: [{ resourceId: READING, title: 'Survey methods', kind: 'native' }],
    ...{ notebooks: [], exercises: [], tests: [] },
  };
  const web = { type: 'slides', title: 'Transects', pdf: null, web: { slides: [slide] } };
  const pdf = { ...web, title: 'Reef zones', pdf: { url: PDF_URL, pageCount: 3 }, web: null };
  const read = { type: 'reading', title: 'Survey methods', kind: 'native', html, pdf: null };
  const at = (id: string) => openPaths.resourceData(COURSE, SAMPLING, id);
  const file = (address: string, schema: { parse(value: unknown): unknown }, value: unknown) =>
    [address, JSON.stringify(schema.parse(value))] as const;
  const course = { title: 'Reef ecology', instructors: ['Ana Lima'], topics };
  return new Map([
    file(openPaths.courseData(COURSE), openCourse, course),
    file(openPaths.topicData(COURSE, SAMPLING), openTopic, lists),
    file(at(WEB), openResource, web),
    file(at(PDF), openResource, pdf),
    file(at(READING), openResource, read),
  ]);
}

/** Every request the shell made: `fetch` serves the data files above and records each call. */
let requests: { url: string; method: string; credentials?: RequestCredentials }[] = [];
function open(address: string, served: Map<string, string>) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET', credentials: init?.credentials });
    const body = served.get(url);
    return body === undefined ? new Response('', { status: 404 }) : new Response(body);
  });
  window.history.replaceState(null, '', address);
  const app = createOpenApp();
  render(app.element);
  return app;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  requests = [];
  window.history.replaceState(null, '', '/');
});

const slides = openPaths.topic(COURSE, SAMPLING, 'slides');

/** No sign-in, provider, join, notes, highlight, sketch, discussion or review control; no Download button. */
function expectNothingOfAClass() {
  const absent = /sign in|notes|google|microsoft|github|join|highlight|sketch|discuss|reviewed/i;
  expect(screen.queryAllByRole('button', { name: absent })).toEqual([]);
  expect(screen.queryAllByRole('link', { name: absent })).toEqual([]);
  expect(screen.queryByRole('button', { name: /download/i })).toBeNull();
}

describe('A44 level 0 shell', () => {
  test("A44 the level 0 shell shows slides and a reading from the build's files, with no request to /api and no sign-in", async () => {
    const user = userEvent.setup();
    const { router } = open(slides, files());
    const viewer = await screen.findByRole('region', { name: 'Slide viewer' });
    expect(within(viewer).getByRole('heading', { name: 'Transects' })).toBeInTheDocument();
    expect(
      screen.getByText('Reef ecology · Topic 1 of 2 · 90 min · Open to everyone · Ana Lima'),
    ).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Slides' }), 'Reef zones');
    await waitFor(() => expect(router.state.location.search).toEqual({ resource: PDF }));
    expect(await screen.findByRole('link', { name: 'Download' })).toHaveAttribute('href', PDF_URL);
    expect(openPdf).toHaveBeenCalledWith(PDF_URL);
    expectNothingOfAClass();
    await expectNoAxeViolations(document.body);

    await user.click(screen.getByRole('tab', { name: 'Reading' }));
    expect(await screen.findByRole('heading', { name: 'Survey methods' })).toBeInTheDocument();
    expect(document.querySelector('math mfrac')).not.toBeNull();

    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request).toMatchObject({ method: 'GET', credentials: 'omit' });
      expect(request.url).toMatch(/^\/courses\/[^?#]+\.json$/);
    }
    expectNothingOfAClass();
    expect([localStorage.length, sessionStorage.length]).toEqual([0, 0]);
    await expectNoAxeViolations(document.body);
  });

  test('A44 slides and readings pass through sanitizeReading at level 0', async () => {
    const hostile = (heading: string) =>
      `<h1>${heading}</h1><script>window.ran = 1</script><img src="x" onerror="window.ran = 2">` +
      `<a href="javascript:window.ran = 3">${heading} link</a>`;
    const clean = () => {
      expect(document.querySelector('script')).toBeNull();
      for (const element of document.body.querySelectorAll('*')) {
        for (const { name, value } of element.attributes) {
          expect(name).not.toMatch(/^on/i);
          expect(value).not.toMatch(/^\s*javascript:/i);
        }
      }
    };
    const user = userEvent.setup();
    open(slides, files(hostile('Planted slide'), hostile('Planted reading')));
    expect(await screen.findByText('Planted slide link')).toBeInTheDocument();
    clean();
    await user.click(screen.getByRole('tab', { name: 'Reading' }));
    expect(await screen.findByText('Planted reading link')).toBeInTheDocument();
    clean();
  });
});

describe('level 0 shell: missing files', () => {
  test('a missing data file shows "This page is not available"', async () => {
    open(openPaths.topic('tide-pools', SAMPLING, 'slides'), files());
    expect(await screen.findByRole('heading', { name: 'This page is not available' })).toBeTruthy();
    expect(requests.map((r) => r.url)).toContain(openPaths.courseData('tide-pools'));
  });
});

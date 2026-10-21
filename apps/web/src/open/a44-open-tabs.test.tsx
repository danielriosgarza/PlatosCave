import { openCatalogue, openCourse, openPaths, openResource, openTopic } from '@parallax/contracts';
import { COLAB_URL } from '@parallax/contracts/routes/notebookSubmissions';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import { createOpenApp } from './app';

/** Data files in the shapes the level 0 build writes for "Reef ecology", each through its schema. */
const COURSE = 'reef-ecology';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ids = <T extends number[]>(...ns: T) => ns.map(uuid) as { [K in keyof T]: string };
const [SAMPLING, TIDES, WEB, READING, NOTEBOOK] = ids(1, 2, 3, 4, 5);
const [FRAMED, ELSEWHERE, COUNT, QUIZ] = ids(6, 7, 8, 9);
const CONTENT = 'https://content.reef.example.org/o/';
const object = (digit: string, ext: string) => `${CONTENT}${digit.repeat(64)}.${ext}`;
const FILE = object('b', 'ipynb');
const ZIP = object('e', 'zip');
const SHINY = 'https://shiny.example.org';
const [TIDE_APP, WAVE_APP] = [`${SHINY}/tides/`, 'https://example.net/waves/'] as const;
const ALL = { slides: true, reading: true, exercises: true, notebooks: true, tests: true };
const ONLY = { ...ALL, slides: false, reading: false, notebooks: false };
const out = (type: string, rest: object) => ({ type, executionCount: 1, ...rest });
const code = { id: 'c', type: 'code', source: 'plot(counts)', executionCount: 1 };
const shown = { sourceHidden: false, outputsHidden: false };

function files({ slide = '<p>Slide</p>', html = '<p>Text</p>', cell = '', output = '' } = {}) {
  const topics = [
    { topicId: SAMPLING, number: 1, title: 'Sampling', estimatedMinutes: 90, presence: ALL },
    { topicId: TIDES, number: 2, title: 'Tides', estimatedMinutes: null, presence: ONLY },
  ].map((t) => ({ ...t, objective: '', firstTab: t.presence.slides ? 'slides' : 'exercises' }));
  const notebooks = [
    { resourceId: NOTEBOOK, title: 'Quadrat counts', type: 'notebook' },
    { resourceId: FRAMED, title: 'Tide app', type: 'shiny' },
    { resourceId: ELSEWHERE, title: 'Wave app', type: 'shiny' },
  ];
  const sampling = {
    ...{ slides: [{ resourceId: WEB, title: 'Transects' }], notebooks },
    reading: [{ resourceId: READING, title: 'Survey', kind: 'native' }],
    exercises: [{ resourceId: COUNT, title: 'Count a transect' }],
    tests: [{ resourceId: QUIZ, title: 'Sampling quiz' }],
  };
  const outputs = [
    out('image', { url: object('c', 'png'), alt: 'Counts per quadrat' }),
    out('html', { url: object('d', 'html'), height: 120, scriptsRemoved: true }),
    out('unsupported', { mimeTypes: ['application/javascript'] }),
    out('markdown', { html: output }),
  ];
  const cells = [
    { id: 'm', type: 'markdown', html: cell },
    { ...code, ...shown, outputs },
  ];
  const notebook = { kernel: 'Python 3', language: 'python', outline: [], cells };
  const file = (address: string, schema: { parse(value: unknown): unknown }, value: unknown) =>
    [address, JSON.stringify(schema.parse(value))] as const;
  const data = (id: string, value: object) =>
    file(openPaths.resourceData(COURSE, SAMPLING, id), openResource, value);
  const course = { title: 'Reef ecology', instructors: ['Ana Lima'], topics };
  return new Map([
    file(openPaths.courseData(COURSE), openCourse, course),
    file(openPaths.courseData(`ana/${COURSE}`), openCourse, course),
    file(openPaths.topicData(COURSE, SAMPLING), openTopic, sampling),
    data(WEB, { type: 'slides', title: 'Transects', pdf: null, web: { slides: [slide] } }),
    data(READING, { type: 'reading', title: 'Survey', kind: 'native', html, pdf: null }),
    data(NOTEBOOK, { type: 'notebook', title: 'Quadrat counts', file: FILE, data: ZIP, notebook }),
    data(FRAMED, { type: 'shiny', title: 'Tide app', url: TIDE_APP, origin: SHINY }),
    data(ELSEWHERE, { type: 'shiny', title: 'Wave app', url: WAVE_APP, origin: null }),
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
  render(createOpenApp().element);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  requests = [];
  window.history.replaceState(null, '', '/');
});

const tab = (name: Parameters<typeof openPaths.topic>[2], topic = SAMPLING) =>
  openPaths.topic(COURSE, topic, name);
const href = (name: string, root = document.body) =>
  within(root).getByRole('link', { name }).getAttribute('href');
/** Axe, as `expectNoAxeViolations` runs it, on a page with frames: jsdom cannot enter a frame. */
const axeWithFrames = async () => {
  const options = { iframes: false, rules: { 'color-contrast': { enabled: false } } };
  const { violations } = await axe.run(document.body, options);
  expect(violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
/** Only `GET`s of data files, without credentials: no request to `/api`, none for an object. */
const onlyDataFiles = () => {
  for (const request of requests) {
    expect(request).toMatchObject({ method: 'GET', credentials: 'omit' });
    expect(request.url).toMatch(/^\/courses\/[^?#]+\.json$/);
  }
};

describe('A44 level 0 tabs', () => {
  test('A44 the level 0 shell shows a rendered notebook with its stored outputs', async () => {
    open(tab('notebooks'), files());
    expect(await screen.findByText('Stored output · Python 3')).toBeInTheDocument();
    expect(screen.getByText('Saved outputs')).toBeInTheDocument();
    const image = screen.getByRole('img', { name: 'Counts per quadrat' });
    expect(image).toHaveAttribute('src', object('c', 'png'));
    const frame = screen.getByTitle('Output of cell [1]');
    expect(frame).toHaveAttribute('sandbox', '');
    expect(frame).toHaveAttribute('src', object('d', 'html'));
    // The two notices beside which level 1 offers "Download original notebook".
    expect(screen.getByText('Scripts in this output were removed and not run')).toBeInTheDocument();
    expect(screen.getByText(/^Interactive output not shown/)).toBeInTheDocument();
    const downloads = screen.getAllByRole('link', { name: 'Download notebook without outputs' });
    for (const link of downloads) expect(link).toHaveAttribute('href', FILE);
    // Working on one's own computer is a download: the notebook with its data files, as a zip.
    const local = screen.getByRole('region', { name: 'Work on your computer' });
    expect(href('the notebook with its data files', local)).toBe(ZIP);
    expect(local).toHaveTextContent('with a python kernel');
    for (const role of ['button', 'link'] as const) {
      expect(
        screen.queryAllByRole(role, { name: /connect|run|submit|original|saved outputs/i }),
      ).toEqual([]);
    }
    onlyDataFiles();
    await axeWithFrames();
  });

  test('A44 the three app-origin surfaces pass through sanitizeReading at level 0', async () => {
    const hostile = (name: string) =>
      `<p>${name}</p><script>window.ran = 1</script><img src="x" onerror="window.ran = 2">` +
      `<a href="javascript:window.ran = 3">${name} link</a>`;
    const clean = async (text: string) => {
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(document.querySelector('script')).toBeNull();
      for (const element of document.body.querySelectorAll('*')) {
        for (const { name, value } of element.attributes) {
          expect(name).not.toMatch(/^on/i);
          expect(value).not.toMatch(/^\s*javascript:/i);
        }
      }
    };
    const user = userEvent.setup();
    const [slide, html, cell, output] = ['Slide', 'Reading', 'Cell', 'Output'].map(hostile);
    open(tab('slides'), files({ slide, html, cell, output }));
    await clean('Slide link');
    await user.click(screen.getByRole('tab', { name: 'Reading' }));
    await clean('Reading link');
    await user.click(screen.getByRole('tab', { name: 'Notebooks' }));
    await clean('Cell link');
    await clean('Output link');
  });

  test('A44 the Exercises and Tests tabs list titles and say they are done in a class', async () => {
    const user = userEvent.setup();
    open(tab('exercises'), files());
    expect(await screen.findByText('Count a transect')).toBeInTheDocument();
    expect(screen.getByText('Exercises are done in a class.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start/i })).toBeNull();
    await expectNoAxeViolations(document.body);
    await user.click(screen.getByRole('tab', { name: 'Tests' }));
    expect(await screen.findByText('Sampling quiz')).toBeInTheDocument();
    expect(screen.getByText('Tests are taken in a class.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start/i })).toBeNull();
    await expectNoAxeViolations(document.body);
    expect(requests.filter(({ url }) => url.includes(COUNT) || url.includes(QUIZ))).toEqual([]);
    onlyDataFiles();
  });

  test('A44 a Shiny app is framed only from a listed origin and keeps its external link, and Colab offers open and download only', async () => {
    const user = userEvent.setup();
    open(`${tab('notebooks')}?resource=${FRAMED}`, files());
    expect(await screen.findByTitle('Tide app')).toHaveAttribute('src', TIDE_APP);
    expect(href('Open externally')).toBe(TIDE_APP);
    await axeWithFrames();

    const picker = screen.getByRole('combobox', { name: 'Notebook' });
    await user.selectOptions(picker, 'Wave app');
    expect(await screen.findByText('Not embedded on this site')).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
    expect(href('Open externally')).toBe(WAVE_APP);
    await expectNoAxeViolations(document.body);

    await user.selectOptions(picker, 'Quadrat counts');
    const colab = await screen.findByRole('region', { name: 'Work in Colab' });
    expect(href('Open in Colab', colab)).toBe(COLAB_URL);
    expect(href('Download notebook without outputs', colab)).toBe(FILE);
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /submit/i })).toBeNull();
    // Opening Colab and the download send nothing: no launch is recorded (jsdom navigates nowhere).
    const stay = (event: Event) => event.preventDefault();
    document.addEventListener('click', stay);
    await user.click(within(colab).getByRole('link', { name: 'Open in Colab' }));
    await user.click(
      within(colab).getByRole('link', { name: 'Download notebook without outputs' }),
    );
    document.removeEventListener('click', stay);
    onlyDataFiles();
    await axeWithFrames();
  });

  test("A44 a school site's catalogue lists instructors, then their courses", async () => {
    const ana = { name: 'Ana Lima', courses: [{ ref: `ana/${COURSE}`, title: 'Reef ecology' }] };
    const bao = { name: 'Bao Tran', courses: [{ ref: 'bao/tide-pools', title: 'Tide pools' }] };
    const school = { mode: 'school', instructors: [ana, bao] };
    const served = files();
    served.set(openPaths.catalogue, JSON.stringify(openCatalogue.parse(school)));
    const user = userEvent.setup();
    open('/', served);
    expect(await screen.findByRole('heading', { level: 1, name: 'Courses' })).toBeInTheDocument();
    const names = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(names).toEqual(['Ana Lima', 'Bao Tran']);
    const [first, second] = screen.getAllByRole('region') as [HTMLElement, HTMLElement];
    expect(href('Reef ecology', first)).toBe(`/courses/ana/${COURSE}`);
    expect(href('Tide pools', second)).toBe('/courses/bao/tide-pools');
    expect(first).toHaveAccessibleName('Ana Lima');
    await expectNoAxeViolations(document.body);
    await user.click(screen.getByRole('link', { name: 'Reef ecology' }));
    expect(await screen.findByRole('heading', { name: 'Reef ecology' })).toBeInTheDocument();
    onlyDataFiles();
    cleanup();

    const withEmail = { ...school, instructors: [{ ...ana, email: 'ana.lima@example.org' }] };
    expect(openCatalogue.safeParse(withEmail).success).toBe(false);
    served.set(openPaths.catalogue, JSON.stringify(withEmail));
    open('/courses', served);
    expect(await screen.findByText('The courses could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText(/ana\.lima@example\.org|Ana Lima/)).toBeNull();
  });
});

describe('level 0 topic index', () => {
  test('the topic index shows number, title, presence and time and links each topic to its first tab', async () => {
    open(openPaths.course(COURSE), files());
    expect(await screen.findByRole('heading', { name: 'Reef ecology' })).toBeInTheDocument();
    expect(screen.getByText('Open to everyone · Ana Lima')).toBeInTheDocument();
    const rows = screen.getAllByRole('row').slice(1) as [HTMLElement, HTMLElement];
    expect(rows.map((row) => row.textContent)).toEqual(['01Sampling90 min', '02Tides—']);
    const marks = (row: Element) =>
      [...row.querySelectorAll('[role="img"]')].map((mark) => mark.getAttribute('aria-label'));
    expect(marks(rows[0]).filter((mark) => mark?.endsWith(': available'))).toHaveLength(5);
    expect(marks(rows[1])).toEqual([
      ...['Slides: not added', 'Reading: not added', 'Exercises: available'],
      ...['Notebooks: not added', 'Tests: available'],
    ]);
    expect(href('Sampling')).toBe(tab('slides'));
    expect(href('Tides')).toBe(tab('exercises', TIDES));
    await expectNoAxeViolations(document.body);
  });
});

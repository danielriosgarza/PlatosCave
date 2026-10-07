import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import type { Notebook } from './notebooks';

const REV = '00000000-0000-4000-8000-000000000701';
const REV_PENDING = '00000000-0000-4000-8000-000000000702';
const RES = '00000000-0000-4000-8000-000000000401';
const SOURCE_KEY = `courses/${COURSE}/objects/${'b'.repeat(64)}`;
const FRAME_URL = 'http://localhost:3100/content/frame-1';
const IMAGE_URL = 'http://localhost:3100/content/image-1';
const NOTEBOOKS = `/classes/${CLASS_A}/topics/${T_SAMPLING}/notebooks`;

const notebook: Notebook = {
  kernel: 'Python 3',
  language: 'python',
  outline: [
    { cellId: 'intro', level: 1, text: 'Repeated samples' },
    { cellId: 'larger', level: 2, text: 'Try a larger sample' },
  ],
  cells: [
    {
      id: 'intro',
      type: 'markdown',
      // A hostile string the server would never store: the browser's own pass must still hold.
      html: '<h1>Repeated samples</h1><p>Draw samples.</p><img src="x" onerror="window.__pwned=1"><script>window.__pwned=2</script>',
    },
    {
      id: 'draw',
      type: 'code',
      source: 'means.std(ddof=1)',
      executionCount: 2,
      sourceHidden: false,
      outputsHidden: false,
      outputs: [{ type: 'text', executionCount: 2, stream: null, text: '0.60', truncated: false }],
    },
    {
      id: 'chart',
      type: 'code',
      source: 'display(HTML(chart))',
      executionCount: 3,
      sourceHidden: false,
      outputsHidden: false,
      outputs: [
        { type: 'html', executionCount: null, url: FRAME_URL, height: 200, scriptsRemoved: true },
        { type: 'image', executionCount: null, url: IMAGE_URL, alt: 'Histogram of means' },
        {
          type: 'table',
          executionCount: null,
          caption: null,
          head: [
            [
              { text: '', header: true },
              { text: 'mean', header: true },
            ],
          ],
          body: [
            [
              { text: '0', header: true },
              { text: '10.1', header: false },
            ],
          ],
          notes: ['1 rows × 1 columns'],
        },
        { type: 'unsupported', executionCount: null, mimeTypes: ['application/javascript'] },
        {
          type: 'error',
          executionCount: null,
          name: 'ValueError',
          value: 'bad value',
          traceback: 'Traceback (most recent call last)',
          truncated: false,
        },
      ],
    },
    {
      id: 'secret',
      type: 'code',
      source: 'answer = 42',
      executionCount: 4,
      sourceHidden: true,
      outputsHidden: false,
      outputs: [],
    },
    { id: 'larger', type: 'markdown', html: '<h2>Try a larger sample</h2>' },
  ],
};

type Reply = { status: number; body?: unknown };

function api(
  me = makeMe({ classes: [studentIn(CLASS_A, 'Class A')] }),
  list = [REV],
  /** Answers the submission routes; they answer "none yet" unless this says otherwise. */
  submissions?: (url: string, init?: RequestInit) => Reply | undefined,
) {
  return stubApi((url, init) => {
    if (url === '/api/me') return { status: 200, body: me };
    if (url.includes('/notebook-submissions') || url.endsWith('/colab-launch')) {
      return (
        submissions?.(url, init) ?? {
          status: 200,
          body: url.endsWith('/colab-launch') ? { launchedAt: null } : { submissions: [] },
        }
      );
    }
    if (url === `/api/classes/${CLASS_A}/topics`) return { status: 200, body: makeTopics() };
    if (url === `/api/classes/${CLASS_A}/topics/${T_SAMPLING}/notebooks`) {
      return {
        status: 200,
        body: {
          notebooks: list.map((revisionId) => ({
            resourceId: RES,
            revisionId,
            title: revisionId === REV ? 'Repeated samples' : 'Still importing',
            type: 'notebook',
          })),
        },
      };
    }
    if (url === `/api/classes/${CLASS_A}/resources/${REV}/notebook`) {
      return {
        status: 200,
        body: {
          revisionId: REV,
          title: 'Repeated samples',
          status: 'ready',
          error: null,
          sourceKey: SOURCE_KEY,
          notebook,
        },
      };
    }
    if (url === `/api/classes/${CLASS_A}/resources/${REV_PENDING}/notebook`) {
      return {
        status: 200,
        body: {
          revisionId: REV_PENDING,
          title: 'Still importing',
          status: 'pending',
          error: null,
          sourceKey: SOURCE_KEY,
          notebook: null,
        },
      };
    }
    return { status: 404, body: {} };
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const content = () => screen.findByRole('tabpanel');

describe('Notebooks tab', () => {
  it('A09 renders cells with execution counts and labels every output group as stored, with its kernel', async () => {
    api();
    renderApp(NOTEBOOKS);
    const panel = await content();
    await within(panel).findByText('means.std(ddof=1)');
    expect(within(panel).getByRole('heading', { name: 'Repeated samples' })).toBeInTheDocument();
    expect(within(panel).getByText('[2]')).toBeInTheDocument();
    expect(within(panel).getByText('0.60')).toBeInTheDocument();
    expect(within(panel).getAllByText('Stored output · Python 3')).toHaveLength(2);
    // The mode says saved outputs; nothing claims a live connection.
    expect(screen.getByText('Saved outputs')).toBeInTheDocument();
    expect(screen.queryByText(/Connected|Ready|Running/)).toBeNull();
    expect(within(panel).getByRole('table')).toHaveTextContent('10.1');
    expect(within(panel).getByText('ValueError: bad value')).toBeInTheDocument();
    expect(
      within(panel).getByText('Interactive output not shown (application/javascript)'),
    ).toBeInTheDocument();
    expect(within(panel).getByRole('img', { name: 'Histogram of means' })).toHaveAttribute(
      'src',
      IMAGE_URL,
    );
  });

  it('A09 an HTML output is a fully sandboxed frame of the content origin, and no script reaches the page', async () => {
    api();
    renderApp(NOTEBOOKS);
    const panel = await content();
    const frame = await within(panel).findByTitle('Output of cell [3]');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('sandbox', '');
    expect(frame).toHaveAttribute('src', FRAME_URL);
    expect(new URL(frame.getAttribute('src') ?? '').origin).not.toBe(window.location.origin);
    expect(
      within(panel).getByText('Scripts in this output were removed and not run'),
    ).toBeInTheDocument();
    expect(panel.querySelector('script')).toBeNull();
    expect(panel.querySelector('[onerror]')).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });

  describe('output links', () => {
    /** A notebook whose output links are minted anew on every fetch, one collapsed cell among them. */
    function apiMintingLinks() {
      let fetches = 0;
      const base = notebook.cells.filter((c) => c.id === 'intro');
      return stubApi((url) => {
        if (url === '/api/me')
          return { status: 200, body: makeMe({ classes: [studentIn(CLASS_A, 'Class A')] }) };
        if (url === `/api/classes/${CLASS_A}/topics`) return { status: 200, body: makeTopics() };
        if (url === NOTEBOOKS.replace('/classes', '/api/classes')) {
          return {
            status: 200,
            body: {
              notebooks: [
                { resourceId: RES, revisionId: REV, title: 'Repeated samples', type: 'notebook' },
              ],
            },
          };
        }
        if (url === `/api/classes/${CLASS_A}/resources/${REV}/notebook`) {
          fetches += 1;
          return {
            status: 200,
            body: {
              revisionId: REV,
              title: 'Repeated samples',
              status: 'ready',
              error: null,
              sourceKey: SOURCE_KEY,
              notebook: {
                ...notebook,
                outline: [],
                cells: [
                  ...base,
                  {
                    id: 'hidden',
                    type: 'code',
                    source: 'chart',
                    executionCount: 5,
                    sourceHidden: false,
                    outputsHidden: true,
                    outputs: [
                      {
                        type: 'html',
                        executionCount: null,
                        url: `http://localhost:3100/content/frame-${fetches}`,
                        height: 200,
                        scriptsRemoved: false,
                      },
                      {
                        type: 'image',
                        executionCount: null,
                        url: `http://localhost:3100/content/image-${fetches}`,
                        alt: 'Histogram of means',
                      },
                    ],
                  },
                ],
              },
            },
          };
        }
        return { status: 404, body: {} };
      });
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('A09 an output revealed after the first links lapsed is shown from a renewed link', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      apiMintingLinks();
      renderApp(NOTEBOOKS);
      const panel = await content();
      const show = await within(panel).findByRole('button', { name: 'Show output of cell [5]' });
      // Six minutes pass with the page open: past the five-minute life of the first links.
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      show.click();
      const frame = await within(panel).findByTitle('Output of cell [5]');
      expect(frame.getAttribute('src')).not.toBe('http://localhost:3100/content/frame-1');
      expect(frame).toHaveAttribute('loading', 'lazy');
      expect(within(panel).getByRole('img', { name: 'Histogram of means' })).not.toHaveAttribute(
        'src',
        'http://localhost:3100/content/image-1',
      );
    });

    it('A09 an output that has loaded keeps its link when the notebook is renewed', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const fetchMock = apiMintingLinks();
      renderApp(NOTEBOOKS);
      const panel = await content();
      await user.click(
        await within(panel).findByRole('button', { name: 'Show output of cell [5]' }),
      );
      const image = await within(panel).findByRole('img', { name: 'Histogram of means' });
      const frame = await within(panel).findByTitle('Output of cell [5]');
      fireEvent.load(image);
      fireEvent.load(frame);
      const asked = () =>
        fetchMock.mock.calls.filter(([u]) => String(u).endsWith(`/${REV}/notebook`)).length;
      const before = asked();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await waitFor(() => expect(asked()).toBeGreaterThan(before));
      expect(image.getAttribute('src')).toBe('http://localhost:3100/content/image-1');
      expect(frame.getAttribute('src')).toBe('http://localhost:3100/content/frame-1');
    });

    it('A09 an image that no longer loads says so, and Try again shows it from a new link', async () => {
      const user = userEvent.setup();
      apiMintingLinks();
      renderApp(NOTEBOOKS);
      const panel = await content();
      await user.click(
        await within(panel).findByRole('button', { name: 'Show output of cell [5]' }),
      );
      const image = await within(panel).findByRole('img', { name: 'Histogram of means' });
      const first = image.getAttribute('src');
      fireEvent.error(image);
      expect(within(panel).getByText(/This image could not be loaded\./)).toBeInTheDocument();
      expect(within(panel).queryByRole('img', { name: 'Histogram of means' })).toBeNull();
      await user.click(within(panel).getByRole('button', { name: 'Try again' }));
      const renewed = await within(panel).findByRole('img', { name: 'Histogram of means' });
      expect(renewed.getAttribute('src')).not.toBe(first);
    });
  });

  it('A09 each code cell collapses and shows its source and its output on its own', async () => {
    const user = userEvent.setup();
    api();
    renderApp(NOTEBOOKS);
    const panel = await content();
    await within(panel).findByText('means.std(ddof=1)');
    const code = within(panel).getByRole('button', { name: 'Collapse code of cell [2]' });
    expect(code).toHaveAttribute('aria-expanded', 'true');
    expect(code).toHaveTextContent('Collapse source');
    await user.click(code);
    expect(within(panel).queryByText('means.std(ddof=1)')).toBeNull();
    // The output of the same cell, and other cells, are untouched.
    expect(within(panel).getByText('0.60')).toBeInTheDocument();
    const show = within(panel).getByRole('button', { name: 'Show code of cell [2]' });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    expect(show).toHaveTextContent('Show source');
    expect(within(panel).getByText('display(HTML(chart))')).toBeInTheDocument();

    const output = within(panel).getByRole('button', { name: 'Collapse output of cell [2]' });
    expect(output).toHaveAttribute('aria-expanded', 'true');
    await user.click(output);
    expect(within(panel).queryByText('0.60')).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Show output of cell [2]' }));
    expect(within(panel).getByText('0.60')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Show code of cell [2]' }));
    expect(within(panel).getByText('means.std(ddof=1)')).toBeInTheDocument();

    // A cell opened one by one can be collapsed again; the toolbar's change resets the cells.
    await user.click(within(panel).getByRole('button', { name: 'Show code of cell [4]' }));
    await user.click(within(panel).getByRole('button', { name: 'Collapse code of cell [4]' }));
    expect(within(panel).queryByText('answer = 42')).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Collapse code of cell [2]' }));
    await user.click(screen.getByRole('button', { name: 'Hide outputs' }));
    expect(within(panel).queryByText('0.60')).toBeNull();
    expect(within(panel).getByText('means.std(ddof=1)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show outputs' }));
    expect(within(panel).getByText('0.60')).toBeInTheDocument();
  });

  it('A09 a notice that an output was removed links to the source download', async () => {
    api();
    renderApp(NOTEBOOKS);
    const panel = await content();
    const unsupported = (await within(panel).findByText(/Interactive output not shown/))
      .parentElement as HTMLElement;
    expect(within(unsupported).getByRole('button', { name: 'Download' })).toBeInTheDocument();
    const removed = within(panel).getByText(/Scripts in this output were removed/)
      .parentElement as HTMLElement;
    expect(within(removed).getByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(within(panel).getAllByRole('button', { name: 'Download' })).toHaveLength(2);
  });

  it('collapses code and outputs independently, honours collapsed cells, and offers outline and download', async () => {
    const user = userEvent.setup();
    api();
    renderApp(NOTEBOOKS);
    const panel = await content();
    await within(panel).findByText('means.std(ddof=1)');
    // The notebook's own collapsed source stays collapsed until asked for.
    expect(within(panel).queryByText('answer = 42')).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Show code of cell [4]' }));
    expect(within(panel).getByText('answer = 42')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Hide code' }));
    expect(within(panel).queryByText('means.std(ddof=1)')).toBeNull();
    expect(within(panel).getByText('0.60')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide outputs' }));
    expect(within(panel).queryByText('0.60')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show code' }));
    expect(within(panel).getByText('means.std(ddof=1)')).toBeInTheDocument();
    expect(within(panel).queryByText('0.60')).toBeNull();

    const outline = screen.getByRole('button', { name: 'Outline' });
    await user.click(outline);
    const nav = within(panel).getByRole('navigation', { name: 'Notebook outline' });
    expect(
      within(nav)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Repeated samples', 'Try a larger sample']);
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    await user.click(within(nav).getByRole('button', { name: 'Try a larger sample' }));
    expect(scrolled).toHaveBeenCalled();
    expect(document.activeElement?.getAttribute('data-cell-id')).toBe('larger');

    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Focus' })).toBeInTheDocument();
  });

  it('shows an import in progress, and offers Add notebook to an editor when there is none', async () => {
    api(makeMe({ classes: [studentIn(CLASS_A, 'Class A')] }), [REV_PENDING]);
    renderApp(NOTEBOOKS);
    expect(await screen.findByText('Still importing is being prepared')).toBeInTheDocument();
    cleanup();
    vi.unstubAllGlobals();

    api(
      makeMe({
        classes: [instructorIn(CLASS_A, 'Class A')],
        courses: [
          {
            courseId: COURSE,
            title: 'Statistical thinking',
            owner: true,
            editor: true,
            publisher: true,
          },
        ],
      }),
      [],
    );
    renderApp(NOTEBOOKS);
    expect(await screen.findByText('No notebook has been added')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Add notebook' })).toBeInTheDocument(),
    );
  });
});

const RESOURCE_URL = `/api/classes/${CLASS_A}/resources/${RES}`;
const receipt = {
  id: '00000000-0000-4000-8000-0000000000e1',
  resourceId: RES,
  resourceRevisionId: REV,
  version: 1,
  filename: 'Repeated samples.ipynb',
  size: 4096,
  sha256: 'ab'.repeat(32),
  environment: { runtime: 'colab', kernel: 'Python 3', language: 'python', nbformat: '4.5' },
  receivedAt: '2026-10-01T09:00:00.000Z',
};
const ipynb = () =>
  new File(['{"nbformat":4}'], 'Repeated samples.ipynb', { type: 'application/octet-stream' });

describe('Colab route and submissions', () => {
  it('A10 Open in Colab is an external link that records a launch and promises no grade or sync', async () => {
    const user = userEvent.setup();
    const fetchMock = api();
    renderApp(NOTEBOOKS);
    const panel = await content();
    const link = await within(panel).findByRole('link', { name: 'Open in Colab' });
    expect(link).toHaveAttribute('href', 'https://colab.research.google.com/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(
      within(panel).getByText(/nothing is graded until you submit a notebook file here/),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/Save a copy in Drive/)).toBeInTheDocument();
    // Opening the link submits nothing.
    link.addEventListener('click', (e) => e.preventDefault());
    await user.click(link);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `${RESOURCE_URL}/colab-launch`,
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/notebook-submissions?')),
    ).toBe(false);
    expect(within(panel).queryByText(/Received/)).toBeNull();
  });

  it('A10 uploading a notebook shows Received only with the receipt the server returned', async () => {
    const user = userEvent.setup();
    let answer: Reply = { status: 200, body: receipt };
    const fetchMock = api(undefined, undefined, (url, init) =>
      init?.method === 'POST' && url.includes('/notebook-submissions?') ? answer : undefined,
    );
    renderApp(NOTEBOOKS);
    const panel = await content();
    const submit = await within(panel).findByRole('button', { name: 'Submit notebook' });
    expect(submit).toBeDisabled();
    await user.upload(within(panel).getByLabelText('Notebook file (.ipynb)'), ipynb());
    // Chosen is not received.
    expect(within(panel).queryByText(/Received/)).toBeNull();
    answer = { status: 400, body: { error: 'invalid', message: 'The file is not text' } };
    await user.click(submit);
    expect(await within(panel).findByRole('alert')).toHaveTextContent('The file is not text');
    expect(within(panel).queryByText(/Received/)).toBeNull();

    answer = { status: 200, body: receipt };
    await user.click(within(panel).getByRole('button', { name: 'Submit notebook' }));
    expect(await within(panel).findByRole('status')).toHaveTextContent(
      /Received .* · version 1 · Repeated samples\.ipynb · 4 KB · checksum abababababab/,
    );
    // The retry after the refusal reused one key, so the server can tell it is the same request.
    const keys = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('/notebook-submissions?'))
      .map((url) => new URL(url, 'http://localhost').searchParams.get('submissionKey'));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    const [, init] = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/notebook-submissions?'),
    ) ?? [undefined, undefined];
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it('A10 a file that is not a notebook is refused in the browser and nothing is sent', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const fetchMock = api();
    renderApp(NOTEBOOKS);
    const panel = await content();
    await user.upload(
      await within(panel).findByLabelText('Notebook file (.ipynb)'),
      new File(['answers'], 'answers.txt'),
    );
    expect(within(panel).getByRole('alert')).toHaveTextContent(
      'Upload a Jupyter notebook (.ipynb) file',
    );
    expect(within(panel).getByRole('button', { name: 'Submit notebook' })).toBeDisabled();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('A10 a student sees their own versions; an instructor sees every student’s with a download', async () => {
    const user = userEvent.setup();
    const mine = [{ ...receipt, version: 2, id: '00000000-0000-4000-8000-0000000000e2' }, receipt];
    api(undefined, undefined, (url) =>
      url.endsWith('/notebook-submissions/mine')
        ? { status: 200, body: { submissions: mine } }
        : undefined,
    );
    renderApp(NOTEBOOKS);
    let panel = await content();
    const heading = await within(panel).findByRole('heading', { name: 'Your submissions' });
    const own = within(heading.parentElement as HTMLElement).getByRole('table');
    expect(within(own).getAllByRole('row').slice(1)).toHaveLength(2);
    expect(
      within(own).getAllByText(/Colab · Python 3 · python \(as declared by the file\)/),
    ).toHaveLength(2);
    expect(within(panel).queryByText('Student submissions')).toBeNull();
    cleanup();
    vi.unstubAllGlobals();

    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const student = { id: '00000000-0000-4000-8000-0000000000f1', name: 'Sam Okafor' };
    const fetchMock = api(
      makeMe({ classes: [instructorIn(CLASS_A, 'Class A')] }),
      undefined,
      (url) => {
        if (url.endsWith('/notebook-submissions')) {
          return { status: 200, body: { submissions: [{ ...receipt, student, removed: false }] } };
        }
        if (url.endsWith('/download')) {
          return {
            status: 200,
            body: {
              url: 'http://localhost:3100/content/snap',
              expiresAt: '2026-10-01T09:05:00.000Z',
            },
          };
        }
        return undefined;
      },
    );
    renderApp(NOTEBOOKS);
    panel = await content();
    expect(await within(panel).findByText('Student submissions')).toBeInTheDocument();
    expect(within(panel).getByText('Sam Okafor')).toBeInTheDocument();
    await user.click(
      within(panel).getByRole('button', { name: 'Download version 1 of Sam Okafor' }),
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith('http://localhost:3100/content/snap'));
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/classes/${CLASS_A}/notebook-submissions/${receipt.id}/download`,
      expect.anything(),
    );
  });

  it('A10 an instructor sees a removed student’s submission labelled "Removed from class"', async () => {
    cleanup();
    vi.unstubAllGlobals();
    const student = { id: '00000000-0000-4000-8000-0000000000f1', name: 'Sam Okafor' };
    api(makeMe({ classes: [instructorIn(CLASS_A, 'Class A')] }), undefined, (url) =>
      url.endsWith('/notebook-submissions')
        ? {
            status: 200,
            body: {
              submissions: [
                { ...receipt, student, removed: true },
                { ...receipt, id: '00000000-0000-4000-8000-0000000000f9', student, removed: false },
              ],
            },
          }
        : undefined,
    );
    renderApp(NOTEBOOKS);
    const panel = await content();
    expect(await within(panel).findAllByText(/Removed from class/)).toHaveLength(1);
  });
});

import { cleanup, screen, waitFor, within } from '@testing-library/react';
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

function api(me = makeMe({ classes: [studentIn(CLASS_A, 'Class A')] }), list = [REV]) {
  return stubApi((url) => {
    if (url === '/api/me') return { status: 200, body: me };
    if (url === `/api/classes/${CLASS_A}/topics`) return { status: 200, body: makeTopics() };
    if (url === `/api/classes/${CLASS_A}/topics/${T_SAMPLING}/notebooks`) {
      return {
        status: 200,
        body: {
          notebooks: list.map((revisionId) => ({
            resourceId: RES,
            revisionId,
            title: revisionId === REV ? 'Repeated samples' : 'Still importing',
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

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
import type { Annotation } from '../margin/data';
import { allowDrafts, clearDrafts } from '../margin/drafts';
import type { PdfDocument } from '../pdfjs';
import type { ReadingList } from '../readings';

const openPdf = vi.hoisted(() => vi.fn());
vi.mock('../pdfjs', () => ({ openPdf }));

const RES = '00000000-0000-4000-8000-000000000401';
const REV = '00000000-0000-4000-8000-000000000501';
const REV_PDF = '00000000-0000-4000-8000-000000000502';
const READING = `/classes/${CLASS_A}/topics/${T_SAMPLING}/reading`;
const FIG1 = 'f00000000001';
const FIG2 = 'f00000000002';
const HTML =
  '<h2 data-block-id="aaaaaaaaaaa1">Why samples vary</h2>' +
  '<p data-block-id="aaaaaaaaaaa2">Every sample tells a slightly different story.</p>' +
  `<figure data-figure-id="${FIG1}"><img src="/figure-1.png" alt="Sample means"><figcaption>Figure 1. Means centred at 10.</figcaption></figure>` +
  `<figure data-figure-id="${FIG2}"><img src="/figure-2.png" alt="Wider samples"><figcaption>Figure 2. Wider samples.</figcaption></figure>`;

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}
interface World {
  kind: 'native' | 'pdf';
  annotations: Annotation[];
  calls: Call[];
  /** Saves answer this status instead of working. */
  refuse: number | null;
  /** Saves fail like a dropped connection. */
  drop: boolean;
  count: number;
  /** The reading's HTML when a test needs other than the default. */
  html?: string;
}
const world = (kind: World['kind'] = 'native', annotations: Annotation[] = []): World => ({
  kind,
  annotations,
  calls: [],
  refuse: null,
  drop: false,
  count: 0,
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(900 + n).padStart(12, '0')}`;
const base = `/api/classes/${CLASS_A}`;

const stored = (
  id: string,
  kind: Annotation['kind'],
  anchor: Annotation['anchor'],
  body: string | null,
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
  placement: { resourceRevisionId: REV, status: 'original', anchor, confidence: null },
  createdAt: '2026-10-01T09:00:00Z',
  updatedAt: '2026-10-01T09:00:00Z',
});

function api(w: World) {
  const me = makeMe({ classes: [studentIn(CLASS_A, 'Class A')] });
  const revisionId = w.kind === 'pdf' ? REV_PDF : REV;
  const readings: ReadingList = {
    lastRevisionId: revisionId,
    readings: [
      {
        resourceId: RES,
        revisionId,
        title: w.kind === 'pdf' ? 'Sampling paper' : 'Why samples vary',
        kind: w.kind,
        position: null,
      },
    ],
  };
  const mock = stubApi((url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    if (url === '/api/me') return { status: 200, body: me };
    if (url === `${base}/topics`) return { status: 200, body: makeTopics() };
    if (url === `${base}/topics/${T_SAMPLING}/readings`) return { status: 200, body: readings };
    if (url === `${base}/resources/${revisionId}/reading`) {
      return {
        status: 200,
        body: {
          revisionId,
          title: 'Reading',
          kind: w.kind,
          status: 'ready',
          error: null,
          sourceKey: null,
          html: w.kind === 'native' ? (w.html ?? HTML) : null,
          pdf:
            w.kind === 'pdf'
              ? {
                  url: 'http://localhost:3100/content/t',
                  expiresAt: '2026-10-01T09:05:00Z',
                  pageCount: 3,
                }
              : null,
        },
      };
    }
    // The PDF's bytes: pdf.js is stubbed, so any answer opens it.
    if (url.startsWith('http://localhost:3100/content/')) return { status: 200, body: {} };
    if (url === `${base}/positions`)
      return { status: 200, body: { updatedAt: '2026-10-01T09:00:00Z' } };
    if (url === `${base}/resources/${RES}/annotations` && method === 'GET') {
      return { status: 200, body: { annotations: w.annotations, threads: [] } };
    }
    if (method !== 'GET') w.calls.push({ method, url, body });
    if (url === `${base}/resources/${RES}/annotations` && method === 'POST') {
      if (w.refuse) return { status: w.refuse, body: { error: 'down' } };
      const made = stored(
        uuid(++w.count),
        body?.kind as Annotation['kind'],
        body?.anchor as Annotation['anchor'],
        (body?.body as string | undefined) ?? null,
      );
      w.annotations = [...w.annotations, made];
      return { status: 200, body: made };
    }
    const saving = /\/annotations\/([^/]+)$/.exec(url);
    if (saving && method === 'PUT') {
      const held = w.annotations.find((a) => a.id === saving[1]);
      if (!held) return { status: 404, body: {} };
      if (held.revision !== body?.expectedRevision) {
        return { status: 409, body: { error: 'revision_conflict', current: held } };
      }
      const saved = {
        ...held,
        anchor: (body?.anchor as Annotation['anchor']) ?? held.anchor,
        body: body?.body as string,
        revision: held.revision + 1,
      };
      w.annotations = w.annotations.map((a) => (a.id === saved.id ? saved : a));
      return { status: 200, body: saved };
    }
    if (saving && method === 'DELETE') {
      w.annotations = w.annotations.filter((a) => a.id !== saving[1]);
      return { status: 200, body: { id: saving[1] } };
    }
    return { status: 404, body: {} };
  });
  const answer = mock.getMockImplementation() as (
    i: RequestInfo | URL,
    n?: RequestInit,
  ) => Promise<Response>;
  mock.mockImplementation(async (input, init) => {
    if (w.drop && init?.method && /\/annotations/.test(String(input))) {
      throw new TypeError('Failed to fetch');
    }
    return answer(input, init);
  });
  return mock;
}

/** A 400 × 200 surface for every canvas: jsdom lays nothing out. */
const SURFACE = { left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, x: 0, y: 0 };

function pdfDocument(): PdfDocument {
  return {
    pageCount: 3,
    pageRatio: async () => 3 / 4,
    renderPage: vi.fn(() => ({
      done: Promise.resolve({ width: 600, height: 800 }),
      cancel: () => {},
    })),
    destroy: vi.fn(),
  };
}

beforeEach(async () => {
  await clearDrafts(null);
  await allowDrafts(SAM_ID);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(
    SURFACE as DOMRect,
  );
  // jsdom has no 2D context; the strokes are what these tests read, not pixels.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  openPdf.mockResolvedValue(pdfDocument());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const openNative = async () => {
  renderApp(READING);
  await screen.findByRole('button', { name: 'Sketch on Figure 1' });
};
const openPdfPage = async () => {
  renderApp(READING);
  await screen.findByRole('button', { name: 'Sketch on Page 1' });
};

/** A stroke the way a pen or mouse makes it: down, move, up on the drawing canvas. */
async function stroke(
  user: ReturnType<typeof userEvent.setup>,
  from: [number, number],
  to: [number, number],
) {
  const canvas = await screen.findByRole('img', { name: /^Freehand sketch on/ });
  await user.pointer([
    { keys: '[MouseLeft>]', target: canvas, coords: { clientX: from[0], clientY: from[1] } },
    { target: canvas, coords: { clientX: to[0], clientY: to[1] } },
    { keys: '[/MouseLeft]', target: canvas, coords: { clientX: to[0], clientY: to[1] } },
  ]);
}

const strokeCount = (n: number) => screen.findByText(`${n} ${n === 1 ? 'stroke' : 'strokes'}`);

describe('sketch on a figure', () => {
  it('A07 offers Sketch on each figure, not on the selection toolbar', async () => {
    api(world());
    await openNative();
    expect(screen.getByRole('button', { name: 'Sketch on Figure 2' })).toBeVisible();
    expect(screen.queryByRole('toolbar', { name: 'Selected passage' })).toBeNull();
    // Nothing takes the touch gesture until a sketch is open.
    expect(document.querySelector('canvas[style*="touch-action"]')).toBeNull();
  });

  it('A07 a drawing can be undone and redone, then saved on the figure with normalised coordinates and its description', async () => {
    const w = world();
    api(w);
    const user = userEvent.setup();
    await openNative();
    await user.click(screen.getByRole('button', { name: 'Sketch on Figure 1' }));
    const panel = await screen.findByRole('region', { name: 'Sketch on Figure 1' });

    // touch-action: none only while drawing.
    const canvas = await screen.findByRole('img', { name: /^Freehand sketch on Figure 1/ });
    expect(canvas).toHaveStyle({ touchAction: 'none' });

    await stroke(user, [100, 50], [200, 100]);
    await stroke(user, [0, 0], [400, 200]);
    await strokeCount(2);
    await user.click(within(panel).getByRole('button', { name: 'Undo' }));
    await strokeCount(1);
    await user.click(within(panel).getByRole('button', { name: 'Redo' }));
    await strokeCount(2);
    await user.click(within(panel).getByRole('button', { name: 'Undo' }));

    await user.type(
      within(panel).getByLabelText('Text description (required)'),
      'A line rising to the right.',
    );
    await user.click(within(panel).getByRole('button', { name: 'Done' }));

    await waitFor(() => expect(w.calls).toHaveLength(1));
    const posted = w.calls[0];
    expect(posted?.method).toBe('POST');
    expect(posted?.body).toEqual({
      kind: 'sketch',
      body: 'A line rising to the right.',
      anchor: {
        kind: 'figure',
        figureId: FIG1,
        strokes: [
          {
            tool: 'pen',
            color: '#202124',
            width: 4,
            points: [
              [0.25, 0.25],
              [0.5, 0.5],
            ],
          },
        ],
      },
    });
    // The editor closes only once the server acknowledged, and the sketch is listed with its text.
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Sketch on Figure 1' })).toBeNull(),
    );
    expect(await screen.findByText('Sketch · Figure 1')).toBeVisible();
    expect(screen.getByText('A line rising to the right.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit sketch on Figure 1' })).toBeVisible();
    expect(document.querySelector('canvas[style*="touch-action"]')).toBeNull();
  });

  it('A07 a saved drawing reopens with its strokes and description, and saves changes against its revision', async () => {
    const strokes = [
      {
        tool: 'pen' as const,
        color: '#315747',
        width: 8,
        points: [
          [0.1, 0.1],
          [0.9, 0.9],
        ] as [number, number][],
      },
    ];
    const w = world('native', [
      stored(uuid(1), 'sketch', { kind: 'figure', figureId: FIG1, strokes }, 'A diagonal.', 3),
    ]);
    api(w);
    const user = userEvent.setup();
    await openNative();
    await user.click(await screen.findByRole('button', { name: 'Open sketch' }));
    const panel = await screen.findByRole('region', { name: 'Sketch on Figure 1' });
    expect(within(panel).getByLabelText('Text description (required)')).toHaveValue('A diagonal.');
    await screen.findByText('1 stroke');

    await stroke(user, [0, 100], [400, 100]);
    await screen.findByText('2 strokes');
    await user.click(within(panel).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(w.calls).toHaveLength(1));
    expect(w.calls[0]?.method).toBe('PUT');
    expect(w.calls[0]?.body).toMatchObject({ expectedRevision: 3, body: 'A diagonal.' });
    const sent = w.calls[0]?.body?.anchor as { strokes: unknown[] };
    expect(sent.strokes).toHaveLength(2);
    expect(sent.strokes[0]).toEqual(strokes[0]);
  });

  it('A07 a drawing without its text description is refused with the reason, and nothing is sent', async () => {
    const w = world();
    api(w);
    const user = userEvent.setup();
    await openNative();
    await user.click(screen.getByRole('button', { name: 'Sketch on Figure 1' }));
    await stroke(user, [10, 10], [300, 150]);
    await user.click(await screen.findByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Describe the sketch in words before finishing.')).toBeVisible();
    expect(w.calls).toHaveLength(0);
    expect(screen.getByLabelText('Text description (required)')).toHaveFocus();
  });

  it('A07 a keyboard-only student supplies the same explanation without drawing', async () => {
    const w = world();
    api(w);
    const user = userEvent.setup();
    await openNative();
    // Reach Describe in text for Figure 2 by Tab, press it with Enter, type, and save with the keyboard.
    const describe = screen.getByRole('button', { name: 'Describe Figure 2 in text' });
    for (let i = 0; i < 40 && document.activeElement !== describe; i++) await user.tab();
    expect(describe).toHaveFocus();
    await user.keyboard('{Enter}');
    const panel = await screen.findByRole('region', { name: 'Sketch on Figure 2' });
    const field = within(panel).getByLabelText('Text description (required)');
    expect(field).toHaveFocus();
    // No canvas and no drawing tools: there is nothing to draw.
    expect(screen.queryByRole('img', { name: /^Freehand sketch/ })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Pen' })).toBeNull();
    await user.keyboard('The wider samples cluster tightly around 10.');
    await user.tab();
    expect(within(panel).getByRole('button', { name: 'Save description' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(w.calls).toHaveLength(1));
    expect(w.calls[0]?.body).toEqual({
      kind: 'note',
      body: 'The wider samples cluster tightly around 10.',
      anchor: { kind: 'figure', figureId: FIG2, strokes: [] },
    });
    expect(await screen.findByText('Description · Figure 2')).toBeVisible();
  });

  it('A07 a save that fails keeps the drawing and the text, and Done tries again', async () => {
    const w = world();
    w.refuse = 503;
    api(w);
    const user = userEvent.setup();
    await openNative();
    await user.click(screen.getByRole('button', { name: 'Sketch on Figure 1' }));
    await stroke(user, [10, 10], [300, 150]);
    await user.type(screen.getByLabelText('Text description (required)'), 'Kept.');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText(/Could not save/)).toBeVisible();
    expect(screen.getByLabelText('Text description (required)')).toHaveValue('Kept.');
    w.refuse = null;
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(w.annotations).toHaveLength(1));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Sketch on Figure 1' })).toBeNull(),
    );
  });

  it('A07 offline says nothing is saved yet instead of claiming a save', async () => {
    const w = world();
    api(w);
    const user = userEvent.setup();
    await openNative();
    await user.click(screen.getByRole('button', { name: 'Sketch on Figure 1' }));
    await stroke(user, [10, 10], [300, 150]);
    await user.type(screen.getByLabelText('Text description (required)'), 'Offline.');
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText(/Offline · not saved/)).toBeVisible();
    expect(screen.queryByText('Saved')).toBeNull();
    expect(w.calls).toHaveLength(0);
  });

  it('A07 the eraser is a stroke of its own and undo takes it back', async () => {
    api(world());
    const user = userEvent.setup();
    await openNative();
    await user.click(screen.getByRole('button', { name: 'Sketch on Figure 1' }));
    await stroke(user, [0, 100], [400, 100]);
    await user.click(screen.getByRole('button', { name: 'Eraser' }));
    expect(screen.getByRole('button', { name: 'Eraser' })).toHaveAttribute('aria-pressed', 'true');
    await stroke(user, [200, 0], [200, 200]);
    await screen.findByText('2 strokes');
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('1 stroke');
    await user.click(screen.getByRole('button', { name: 'Colour Green' }));
    expect(screen.getByRole('button', { name: 'Colour Green' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Pen' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('A07 Discard drops an unsaved drawing; Delete sketch removes a saved one', async () => {
    const strokes = [
      {
        tool: 'pen' as const,
        color: '#202124',
        width: 4,
        points: [
          [0.1, 0.1],
          [0.9, 0.9],
        ] as [number, number][],
      },
    ];
    const w = world('native', [
      stored(uuid(1), 'sketch', { kind: 'figure', figureId: FIG1, strokes }, 'A diagonal.'),
    ]);
    api(w);
    const user = userEvent.setup();
    await openNative();
    await user.click(await screen.findByRole('button', { name: 'Open sketch' }));
    await stroke(user, [0, 0], [10, 10]);
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('region', { name: 'Sketch on Figure 1' })).toBeNull();
    expect(w.calls).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Delete sketch' }));
    await waitFor(() => expect(w.annotations).toHaveLength(0));
    await waitFor(() => expect(screen.queryByText('Sketch · Figure 1')).toBeNull());
  });

  it('A07 a sketch edited elsewhere offers the saved copy or the drawing on this device', async () => {
    const strokes = [
      {
        tool: 'pen' as const,
        color: '#202124',
        width: 4,
        points: [
          [0.1, 0.1],
          [0.9, 0.9],
        ] as [number, number][],
      },
    ];
    const w = world('native', [
      stored(uuid(1), 'sketch', { kind: 'figure', figureId: FIG1, strokes }, 'Mine.', 1),
    ]);
    api(w);
    const user = userEvent.setup();
    await openNative();
    await user.click(await screen.findByRole('button', { name: 'Open sketch' }));
    // Another device saves first.
    w.annotations = w.annotations.map((a) => ({ ...a, body: 'Theirs.', revision: 2 }));
    await stroke(user, [0, 0], [50, 50]);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('This sketch changed somewhere else')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Keep my drawing' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(w.annotations[0]?.revision).toBe(3));
    expect(w.annotations[0]?.body).toBe('Mine.');
  });

  it('A07 Download SVG hands over the drawing as SVG with its description', async () => {
    const strokes = [
      {
        tool: 'pen' as const,
        color: '#202124',
        width: 4,
        points: [
          [0, 0],
          [1, 1],
        ] as [number, number][],
      },
    ];
    api(
      world('native', [
        stored(uuid(1), 'sketch', { kind: 'figure', figureId: FIG1, strokes }, 'A diagonal.'),
      ]),
    );
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob | MediaSource) => {
      blobs.push(b as Blob);
      return 'blob:sketch';
    });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const user = userEvent.setup();
    await openNative();
    await user.click(await screen.findByRole('button', { name: 'Download SVG' }));
    expect(click).toHaveBeenCalled();
    const svg = await blobs[0]?.text();
    expect(svg).toContain('<svg');
    expect(svg).toContain('<desc>A diagonal.</desc>');
    expect(svg).toContain('points="0,0 900,450"');
  });

  it('A07 Download SVG clicks a link in the document and releases the file only after the click', async () => {
    const strokes = [
      {
        tool: 'pen' as const,
        color: '#202124',
        width: 4,
        points: [
          [0, 0],
          [1, 1],
        ] as [number, number][],
      },
    ];
    api(
      world('native', [
        stored(uuid(1), 'sketch', { kind: 'figure', figureId: FIG1, strokes }, 'A diagonal.'),
      ]),
    );
    URL.createObjectURL = vi.fn(() => 'blob:sketch');
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    const clicked: { attached: boolean; href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({
        attached: document.body.contains(this),
        href: this.href,
        download: this.download,
      });
    });
    const user = userEvent.setup();
    await openNative();
    await user.click(await screen.findByRole('button', { name: 'Download SVG' }));
    expect(clicked).toEqual([
      { attached: true, href: 'blob:sketch', download: 'sketch-figure-1.svg' },
    ]);
    // Some browsers start the download after the click returns: the file stays available a while.
    expect(revoke).not.toHaveBeenCalled();
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:sketch'), { timeout: 3000 });
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('A07 a stroke does not start a text selection, so the selection toolbar stays away while drawing', async () => {
    api(world());
    const user = userEvent.setup();
    await openNative();
    await user.click(screen.getByRole('button', { name: 'Sketch on Figure 1' }));
    const downs: PointerEvent[] = [];
    const mice: MouseEvent[] = [];
    const onDown = (e: Event) => downs.push(e as PointerEvent);
    const onMouse = (e: Event) => mice.push(e as MouseEvent);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('mousedown', onMouse);
    try {
      await stroke(user, [10, 10], [390, 190]);
    } finally {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('mousedown', onMouse);
    }
    await strokeCount(1);
    expect(downs).toHaveLength(1);
    expect(downs[0]?.defaultPrevented).toBe(true);
    // With the pointer's default action prevented, no mousedown follows to begin a selection.
    expect(mice).toEqual([]);
    expect(document.getSelection()?.toString() ?? '').toBe('');
    expect(screen.queryByRole('toolbar', { name: 'Selected passage' })).toBeNull();
  });
});

describe('sketches already saved', () => {
  const line = [
    {
      tool: 'pen' as const,
      color: '#202124',
      width: 4,
      points: [
        [0.1, 0.1],
        [0.9, 0.9],
      ] as [number, number][],
    },
  ];

  it('A07 Open sketch does not replace a sketch that is open with unsaved work', async () => {
    api(
      world('native', [
        stored(uuid(2), 'sketch', { kind: 'figure', figureId: FIG2, strokes: line }, 'Second.'),
      ]),
    );
    const user = userEvent.setup();
    await openNative();
    const open = await screen.findByRole('button', { name: 'Open sketch' });
    await user.click(screen.getByRole('button', { name: 'Sketch on Figure 1' }));
    await stroke(user, [10, 10], [300, 150]);
    await user.type(screen.getByLabelText('Text description (required)'), 'Unsaved.');
    expect(open).toBeDisabled();
    await user.click(open);
    expect(screen.getByRole('region', { name: 'Sketch on Figure 1' })).toBeVisible();
    expect(screen.getByLabelText('Text description (required)')).toHaveValue('Unsaved.');
    expect(screen.getByText('1 stroke')).toBeVisible();
  });

  it('A07 a sketch mapped to a newer revision cannot be edited in place, but can be exported, deleted and replaced by a new sketch', async () => {
    const mapped = stored(
      uuid(3),
      'sketch',
      { kind: 'figure', figureId: 'oldfigure0001', strokes: line },
      'Old.',
    );
    mapped.placement = {
      resourceRevisionId: REV,
      status: 'mapped',
      anchor: { kind: 'figure', figureId: FIG1, strokes: line },
      confidence: 0.95,
    };
    const w = world('native', [mapped]);
    api(w);
    const user = userEvent.setup();
    await openNative();
    expect(await screen.findByRole('button', { name: 'Open sketch' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Download SVG' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete sketch' })).toBeEnabled();
    // Sketch starts a new drawing on the current revision rather than rewriting the old anchor.
    expect(screen.getByRole('button', { name: 'Sketch on Figure 1' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Sketch on Figure 1' }));
    await stroke(user, [10, 10], [300, 150]);
    await user.type(screen.getByLabelText('Text description (required)'), 'New.');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(w.calls).toHaveLength(1));
    expect(w.calls[0]?.method).toBe('POST');
    expect(w.annotations.find((a) => a.id === mapped.id)?.anchor).toMatchObject({
      figureId: 'oldfigure0001',
    });
  });

  it('A07 a sketch on a revision still being mapped says it is waiting to be placed, not lost', async () => {
    const waiting = stored(
      uuid(4),
      'sketch',
      { kind: 'figure', figureId: 'oldfigure0001', strokes: line },
      'Waiting.',
    );
    waiting.placement = {
      resourceRevisionId: REV,
      status: 'pending',
      anchor: null,
      confidence: null,
    };
    api(world('native', [waiting]));
    await openNative();
    expect(await screen.findByText('Waiting to be placed')).toBeVisible();
    expect(screen.queryByText('Needs reattachment')).toBeNull();
    // Until it is placed there is nowhere to draw it, but it can still be exported or deleted.
    expect(screen.getByRole('button', { name: 'Open sketch' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Download SVG' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete sketch' })).toBeEnabled();
  });
});

describe('sketch editor reachability', () => {
  it('A07 on a figure without a picture the tools and panel stay above the ink layer', async () => {
    const w = world();
    // A figure known by its text alone: no picture for the layer to follow.
    w.html = `<p data-block-id="aaaaaaaaaaa2">Text.</p><figure data-figure-id="${FIG1}"><table><tr><td>n</td></tr></table><figcaption>Figure 1. A table.</figcaption></figure>`;
    api(w);
    const user = userEvent.setup();
    await openNative();
    await user.click(screen.getByRole('button', { name: 'Sketch on Figure 1' }));
    const panel = await screen.findByRole('region', { name: 'Sketch on Figure 1' });
    expect(document.querySelector(`figure[data-figure-id="${FIG1}"] img`)).toBeNull();

    // touch-action: none only while drawing.
    const canvas = await screen.findByRole('img', { name: /^Freehand sketch on Figure 1/ });
    expect(canvas).toHaveStyle({ touchAction: 'none' });

    // Both lie in the same figure; the host of the panel is positioned with a higher stacking order.
    const host = panel.parentElement;
    const layer = canvas.closest('div[style*="position: absolute"]') as HTMLElement;
    expect(host?.style.position).toBe('relative');
    expect(Number(host?.style.zIndex)).toBeGreaterThan(Number(layer.style.zIndex || 0));

    await stroke(user, [100, 50], [200, 100]);
    await stroke(user, [0, 0], [400, 200]);
    await strokeCount(2);
    await user.click(within(panel).getByRole('button', { name: 'Undo' }));
    await strokeCount(1);
    await user.click(within(panel).getByRole('button', { name: 'Redo' }));
    await strokeCount(2);
    await user.click(within(panel).getByRole('button', { name: 'Undo' }));

    await user.type(
      within(panel).getByLabelText('Text description (required)'),
      'A line rising to the right.',
    );
    await user.click(within(panel).getByRole('button', { name: 'Done' }));

    await waitFor(() => expect(w.calls).toHaveLength(1));
    const posted = w.calls[0];
    expect(posted?.method).toBe('POST');
    expect(posted?.body).toEqual({
      kind: 'sketch',
      body: 'A line rising to the right.',
      anchor: {
        kind: 'figure',
        figureId: FIG1,
        strokes: [
          {
            tool: 'pen',
            color: '#202124',
            width: 4,
            points: [
              [0.25, 0.25],
              [0.5, 0.5],
            ],
          },
        ],
      },
    });
    // The editor closes only once the server acknowledged, and the sketch is listed with its text.
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Sketch on Figure 1' })).toBeNull(),
    );
    expect(await screen.findByText('Sketch · Figure 1')).toBeVisible();
    expect(screen.getByText('A line rising to the right.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit sketch on Figure 1' })).toBeVisible();
    expect(document.querySelector('canvas[style*="touch-action"]')).toBeNull();
  });

  it('A07 Delete sketch is unavailable while that sketch is open, so it cannot be recreated by Done', async () => {
    const line = [
      {
        tool: 'pen' as const,
        color: '#202124',
        width: 4,
        points: [
          [0.1, 0.1],
          [0.9, 0.9],
        ] as [number, number][],
      },
    ];
    const w = world('native', [
      stored(uuid(1), 'sketch', { kind: 'figure', figureId: FIG1, strokes: line }, 'A diagonal.'),
    ]);
    api(w);
    const user = userEvent.setup();
    await openNative();
    await user.click(await screen.findByRole('button', { name: 'Open sketch' }));
    expect(screen.getByRole('button', { name: 'Delete sketch' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByRole('button', { name: 'Delete sketch' })).toBeEnabled();
  });
});

describe('sketch on a PDF page', () => {
  it('A07 saves a page sketch as a pdf anchor with page-relative strokes, and holds the page while it is open', async () => {
    const w = world('pdf');
    api(w);
    const user = userEvent.setup();
    await openPdfPage();
    await user.click(screen.getByRole('button', { name: 'Sketch on Page 1' }));
    const panel = await screen.findByRole('region', { name: 'Sketch on Page 1' });
    // Changing page would lose the drawing: the page controls wait for Done or Discard.
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    await stroke(user, [100, 50], [300, 150]);
    await user.type(
      within(panel).getByLabelText('Text description (required)'),
      'Circle the second formula.',
    );
    await user.click(within(panel).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(w.calls).toHaveLength(1));
    expect(w.calls[0]?.body).toEqual({
      kind: 'sketch',
      body: 'Circle the second formula.',
      anchor: {
        kind: 'pdf',
        page: 0,
        rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
        strokes: [
          {
            tool: 'pen',
            color: '#202124',
            width: 4,
            points: [
              [0.25, 0.25],
              [0.75, 0.75],
            ],
          },
        ],
      },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled());
    expect(await screen.findByText('Sketch · Page 1')).toBeVisible();
  });

  it('A06 zooming the page between strokes keeps every stroke and the saved rect in normalised page space', async () => {
    const w = world('pdf');
    api(w);
    const user = userEvent.setup();
    await openPdfPage();
    await user.click(screen.getByRole('button', { name: 'Sketch on Page 1' }));
    const panel = await screen.findByRole('region', { name: 'Sketch on Page 1' });
    await stroke(user, [100, 50], [300, 150]);
    // The reader zooms in: the same page is now twice as wide and tall on screen.
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      ...SURFACE,
      width: 800,
      height: 400,
      right: 800,
      bottom: 400,
    } as DOMRect);
    window.dispatchEvent(new Event('resize'));
    await stroke(user, [200, 100], [600, 300]);
    await strokeCount(2);
    await user.type(within(panel).getByLabelText('Text description (required)'), 'Zoomed.');
    await user.click(within(panel).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(w.calls).toHaveLength(1));
    const points: [number, number][] = [
      [0.25, 0.25],
      [0.75, 0.75],
    ];
    const pen = { tool: 'pen', color: '#202124', width: 4, points };
    expect(w.calls[0]?.body).toEqual({
      kind: 'sketch',
      body: 'Zoomed.',
      anchor: {
        kind: 'pdf',
        page: 0,
        rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
        strokes: [pen, pen],
      },
    });
  });

  it('A07 describes a page in text without drawing', async () => {
    const w = world('pdf');
    api(w);
    const user = userEvent.setup();
    await openPdfPage();
    await user.click(screen.getByRole('button', { name: 'Describe Page 1 in text' }));
    await user.keyboard('The table compares n = 25 with n = 100.');
    await user.click(screen.getByRole('button', { name: 'Save description' }));
    await waitFor(() => expect(w.calls).toHaveLength(1));
    expect(w.calls[0]?.body).toEqual({
      kind: 'note',
      body: 'The table compares n = 25 with n = 100.',
      anchor: { kind: 'pdf', page: 0, rect: { x: 0, y: 0, w: 1, h: 1 } },
    });
    expect(await screen.findByText('Description · Page 1')).toBeVisible();
  });

  it('A07 Open sketch on a sketch of another page turns to that page', async () => {
    const strokes = [
      {
        tool: 'pen' as const,
        color: '#202124',
        width: 4,
        points: [
          [0.1, 0.1],
          [0.9, 0.9],
        ] as [number, number][],
      },
    ];
    api(
      world('pdf', [
        stored(
          uuid(1),
          'sketch',
          { kind: 'pdf', page: 2, rect: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, strokes },
          'Third page.',
        ),
      ]),
    );
    const user = userEvent.setup();
    await openPdfPage();
    await user.click(await screen.findByRole('button', { name: 'Open sketch' }));
    expect(await screen.findByRole('region', { name: 'Sketch on Page 3' })).toBeVisible();
    expect(screen.getByText('Page 3 of 3')).toBeVisible();
  });

  it('A07 Download SVG of a page not yet shown takes the page proportions from the PDF', async () => {
    const strokes = [
      {
        tool: 'pen' as const,
        color: '#202124',
        width: 4,
        points: [
          [0, 0],
          [1, 1],
        ] as [number, number][],
      },
    ];
    // Page 3 is landscape: 4 wide by 3 high.
    openPdf.mockResolvedValue({
      ...pdfDocument(),
      pageRatio: async (n: number) => (n === 3 ? 4 / 3 : 3 / 4),
    });
    api(
      world('pdf', [
        stored(
          uuid(1),
          'sketch',
          { kind: 'pdf', page: 2, rect: { x: 0, y: 0, w: 1, h: 1 }, strokes },
          'Third page.',
        ),
      ]),
    );
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob | MediaSource) => {
      blobs.push(b as Blob);
      return 'blob:sketch';
    });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const user = userEvent.setup();
    await openPdfPage();
    expect(screen.getByText('Page 1 of 3')).toBeVisible();
    await user.click(await screen.findByRole('button', { name: 'Download SVG' }));
    const svg = await blobs[0]?.text();
    expect(svg).toContain('viewBox="0 0 900 675"');
    expect(svg).toContain('points="0,0 900,675"');
  });
});

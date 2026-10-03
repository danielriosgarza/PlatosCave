import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COURSE, makeMe, renderApp, stubApi } from './render';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TOPIC = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';
const RESOURCE = '00000000-0000-4000-8000-0000000000b1';
const NEW_RESOURCE = '00000000-0000-4000-8000-0000000000b2';
const REVISION = '00000000-0000-4000-8000-0000000000c1';
const SAM = '00000000-0000-4000-8000-000000000004';
const stamp = '2026-10-01T09:00:00.000Z';

const grant = (over: Partial<{ owner: boolean; editor: boolean; publisher: boolean }> = {}) =>
  makeMe({
    courses: [
      {
        courseId: COURSE,
        title: 'Statistical thinking',
        owner: false,
        editor: true,
        publisher: true,
        ...over,
      },
    ],
  });

const topic = (over: Record<string, unknown> = {}) => ({
  id: TOPIC,
  courseId: COURSE,
  position: 0,
  title: 'Sampling',
  objective: 'Explain why estimates differ.',
  prerequisites: [],
  completionRule: null,
  estimatedMinutes: 45,
  revision: 1,
  archived: false,
  updatedAt: stamp,
  ...over,
});

const resource = (over: Record<string, unknown> = {}) => ({
  id: RESOURCE,
  courseId: COURSE,
  topicId: TOPIC,
  type: 'reading_native',
  title: 'Why samples vary',
  position: 0,
  visibility: 'visible',
  releaseAt: null,
  headRevisionId: REVISION,
  revision: 1,
  archived: false,
  updatedAt: stamp,
  ...over,
});

interface Server {
  topic: ReturnType<typeof topic>;
  resources: ReturnType<typeof resource>[];
  processing: { state: string | null; error?: string | null };
  latest: number | null;
  classUses: number | null;
  report: { errors: object[]; warnings: object[] };
  patched: { url: string; body: Record<string, unknown> }[];
  /** Answers PATCH /topics with this status instead of saving. */
  topicStatus?: number;
  conflictWith?: ReturnType<typeof topic>;
  publishStatus?: number;
  /** GET /processing answers with this status instead of the entries. */
  processingStatus?: number;
  classArchived?: boolean;
  uploads: number;
  /** PATCH of this topic id answers with this status (reorder tests). */
  otherStatus?: number;
  /** The Markdown a web deck's head revision holds. */
  deckMarkdown?: string;
}

function fresh(over: Partial<Server> = {}): Server {
  return {
    topic: topic(),
    resources: [resource()],
    processing: { state: 'ready' },
    latest: 2,
    classUses: 2,
    report: { errors: [], warnings: [] },
    patched: [],
    uploads: 0,
    ...over,
  };
}

const json = (body: unknown, status = 200) => ({ status, body });

function api(me: ReturnType<typeof makeMe>, s: Server) {
  return stubApi((url, init) => {
    const method = init?.method ?? 'GET';
    const path = url.split('?')[0] ?? url;
    if (path === '/api/me') return json(me);
    const base = `/api/courses/${COURSE}`;
    if (path === `${base}/drafts`) {
      return json({
        topics: [
          { ...s.topic, resources: s.resources },
          { ...topic({ id: OTHER, title: 'Estimation', position: 1 }), resources: [] },
        ],
      });
    }
    if (path === `${base}/overview`) {
      return json({
        id: COURSE,
        title: 'Statistical thinking',
        latestRelease: s.latest ? { id: COURSE, version: s.latest, createdAt: stamp } : null,
        classes: [
          {
            id: COURSE,
            name: 'Class A',
            archived: s.classArchived ?? false,
            release: s.classUses ? { id: COURSE, version: s.classUses } : null,
          },
        ],
      });
    }
    if (path === `${base}/processing`) {
      if (s.processingStatus) return json({ error: 'boom' }, s.processingStatus);
      return json({
        resources: s.resources.map((r) => ({
          resourceId: r.id,
          topicId: TOPIC,
          title: r.title,
          revisionId: REVISION,
          state: s.processing.state,
          error: s.processing.error ?? null,
          updatedAt: stamp,
        })),
      });
    }
    if (path === `${base}/releases/validation`) return json(s.report);
    if (path === `${base}/releases` && method === 'POST') {
      if (s.publishStatus === 403) return json({ error: 'forbidden' }, 403);
      if (s.publishStatus === 422) {
        return json({ error: 'validation_failed', report: s.report }, 422);
      }
      s.latest = (s.latest ?? 0) + 1;
      return json({
        release: { id: COURSE, version: s.latest, createdAt: stamp },
        report: s.report,
      });
    }
    if (path === `${base}/topics/${OTHER}` && method === 'PATCH') {
      const body = JSON.parse(String(init?.body));
      s.patched.push({ url: path, body });
      if (s.otherStatus) return json({ error: 'x' }, s.otherStatus);
      return json(topic({ id: OTHER, position: body.position, revision: 2 }));
    }
    if (path === `${base}/topics/${TOPIC}` && method === 'PATCH') {
      const body = JSON.parse(String(init?.body));
      s.patched.push({ url: path, body });
      if (s.topicStatus === 409 && s.conflictWith) {
        return json({ error: 'revision_conflict', current: s.conflictWith }, 409);
      }
      if (s.topicStatus && s.topicStatus >= 500) return json({ error: 'boom' }, s.topicStatus);
      s.topic = topic({ ...s.topic, ...body, revision: s.topic.revision + 1 });
      return json(s.topic);
    }
    if (path === `${base}/uploads` && method === 'POST') {
      s.uploads += 1;
      return json({
        key: `courses/${COURSE}/objects/${'a'.repeat(64)}`,
        sha256: 'a'.repeat(64),
        size: 12,
        format: 'markdown',
        filename: 'week3.md',
      });
    }
    if (path === `${base}/topics/${TOPIC}/resources` && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      s.patched.push({ url: path, body });
      const created = resource({ id: NEW_RESOURCE, title: body.title });
      s.resources = [...s.resources, created];
      s.processing = { state: 'queued' };
      return json({ ...created, head: null });
    }
    if (path === `${base}/resources/${RESOURCE}`) {
      const found = s.resources.find((r) => r.id === RESOURCE) ?? resource();
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body));
        s.patched.push({ url: path, body });
        if ('content' in body) s.deckMarkdown = (body.content as { markdown: string }).markdown;
        return json({ ...found, ...body, revision: found.revision + 1, head: head(s) });
      }
      return json({ ...found, head: head(s) });
    }
    return json({ error: 'not found' }, 404);
  });
}

const head = (s: Server) => ({
  id: REVISION,
  content: { markdown: s.deckMarkdown ?? '# Old' },
  objectKeys: [],
  accessibleAlternative: null,
  provenance: null,
  contentHash: 'h',
  createdBy: SAM,
  createdAt: stamp,
});

/** Holds matching requests until released, so a test can act while one is in flight. */
function hold(
  fetchMock: ReturnType<typeof api>,
  match: (url: string, init?: RequestInit) => boolean,
) {
  const original = fetchMock.getMockImplementation();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = { count: 0 };
  fetchMock.mockImplementation(async (input, init) => {
    if (match(String(input), init)) {
      held.count += 1;
      await gate;
    }
    return original?.(input, init) as Promise<Response>;
  });
  return { held, release };
}

const open = async (me = grant(), s = fresh()) => {
  const fetchMock = api(me, s);
  const view = renderApp(`/courses/${COURSE}/edit/${TOPIC}`);
  await screen.findByRole('heading', { name: 'Edit topic' });
  return { s, fetchMock, ...view };
};

describe('topic editor', () => {
  it('A26 shows which release the class uses and says edits touch the draft only', async () => {
    await open();
    const panel = await screen.findByRole('complementary', { name: 'Publication' });
    expect(await within(panel).findByText(/Class A uses release 2\./)).toBeInTheDocument();
    expect(screen.getByText(/Edits change the course draft only/)).toBeInTheDocument();
  });

  it('A26 autosaves with the last revision and shows Saved only after the server answered', async () => {
    const user = userEvent.setup();
    const { s } = await open();
    const title = await screen.findByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Sampling distributions');
    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument();
    await waitFor(() => expect(s.patched).toHaveLength(1), { timeout: 3000 });
    expect(s.patched[0]?.body).toMatchObject({
      expectedRevision: 1,
      title: 'Sampling distributions',
      estimatedMinutes: 45,
      completionRule: null,
    });
    expect(await screen.findByText(/Draft saved at/)).toBeInTheDocument();
    // The next edit is based on the revision the server just acknowledged.
    await user.type(screen.getByLabelText('Learning objective'), ' Again.');
    await waitFor(() => expect(s.patched).toHaveLength(2), { timeout: 3000 });
    expect(s.patched[1]?.body.expectedRevision).toBe(2);
  });

  it('A26 a failed save is reported and can be retried; nothing claims it saved', async () => {
    const user = userEvent.setup();
    const { s } = await open(grant(), fresh({ topicStatus: 503 }));
    await user.type(await screen.findByLabelText('Learning objective'), '!');
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent(
      'Your changes are not saved.',
    );
    expect(screen.queryByText(/Draft saved/)).toBeNull();
    s.topicStatus = undefined;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/Draft saved at/)).toBeInTheDocument();
  });

  it('A26 Retry after a failed save sends the edits once, not again for a request made during the failure', async () => {
    const user = userEvent.setup();
    const s = fresh({ topicStatus: 503 });
    const fetchMock = api(grant(), s);
    const gate = hold(
      fetchMock,
      (url, init) => init?.method === 'PATCH' && url.endsWith(`/topics/${TOPIC}`),
    );
    renderApp(`/courses/${COURSE}/edit/${TOPIC}`);
    const objective = await screen.findByLabelText('Learning objective');
    await user.type(objective, 'a');
    await waitFor(() => expect(gate.held.count).toBe(1), { timeout: 3000 });
    // An edit while the first save is in flight asks for another save, which waits behind it.
    await user.type(objective, 'b');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    gate.release();
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent(
      'Your changes are not saved.',
    );
    s.topicStatus = undefined;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/Draft saved at/)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The failed attempt and one retry; no third request with the same values.
    expect(s.patched).toHaveLength(2);
    expect(s.topic.revision).toBe(2);
  });

  it('A26 a stale revision shows both versions and keeps the choice with the editor', async () => {
    const user = userEvent.setup();
    const theirs = topic({ title: 'Sampling, by Priya', revision: 3 });
    const { s } = await open(grant(), fresh({ topicStatus: 409, conflictWith: theirs }));
    const title = await screen.findByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'My title');
    const conflict = await screen.findByRole(
      'alert',
      { name: 'Editing conflict' },
      { timeout: 3000 },
    );
    expect(within(conflict).getByText('My title')).toBeInTheDocument();
    expect(within(conflict).getByText('Sampling, by Priya')).toBeInTheDocument();
    expect(screen.queryByText(/Draft saved/)).toBeNull();

    s.topicStatus = undefined;
    s.topic = theirs;
    await user.click(within(conflict).getByRole('button', { name: 'Keep my version' }));
    await waitFor(() => expect(s.patched).toHaveLength(2), { timeout: 3000 });
    // Their revision is the base: the save cannot overwrite it unseen.
    expect(s.patched[1]?.body).toMatchObject({ expectedRevision: 3, title: 'My title' });
    expect(await screen.findByText(/Draft saved at/)).toBeInTheDocument();
  });

  it('A26 taking their version replaces the form without saving anything', async () => {
    const user = userEvent.setup();
    const theirs = topic({ title: 'Sampling, by Priya', revision: 3 });
    const { s, router } = await open(grant(), fresh({ topicStatus: 409, conflictWith: theirs }));
    await user.type(await screen.findByLabelText('Title'), '!');
    const conflict = await screen.findByRole(
      'alert',
      { name: 'Editing conflict' },
      { timeout: 3000 },
    );
    await user.click(within(conflict).getByRole('button', { name: 'Use their version' }));
    expect(await screen.findByDisplayValue('Sampling, by Priya')).toBeInTheDocument();
    expect(s.patched).toHaveLength(1);
    // Leaving must not send their own copy back (which would bump the revision under them).
    await router.navigate({ to: '/courses/$courseId/edit', params: { courseId: COURSE } });
    await screen.findByRole('heading', { name: 'Topics' });
    expect(s.patched).toHaveLength(1);
  });

  it('A26 refuses to save a topic without a title and says why', async () => {
    const user = userEvent.setup();
    const { s } = await open();
    await user.clear(await screen.findByLabelText('Title'));
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent(
      'A topic needs a title',
    );
    expect(s.patched).toHaveLength(0);
  });

  it('A26 a student with no course grant sees the neutral unavailable page', async () => {
    api(makeMe(), fresh());
    renderApp(`/courses/${COURSE}/edit/${TOPIC}`);
    expect(
      await screen.findByRole('heading', { name: 'This page is not available' }),
    ).toBeInTheDocument();
  });
});

describe('reading upload', () => {
  it('A26 adds a reading from a file: uploads it, creates the resource and shows its processing state', async () => {
    const user = userEvent.setup();
    const { s } = await open();
    await user.click(await screen.findByRole('button', { name: 'Add reading' }));
    const form = screen.getByRole('form', { name: 'Add reading' });
    await user.upload(
      within(form).getByLabelText(/File/),
      new File(['# Week 3'], 'week3.md', { type: 'text/markdown' }),
    );
    expect(within(form).getByLabelText('Title')).toHaveValue('week3');
    await user.type(within(form).getByLabelText('Accessible alternative'), 'Plain text version');
    await user.click(within(form).getByRole('button', { name: 'Add reading' }));
    await waitFor(() => expect(s.uploads).toBe(1));
    const created = s.patched.find((p) => p.url.endsWith('/resources'))?.body;
    expect(created).toMatchObject({
      type: 'reading_native',
      title: 'week3',
      content: { sourceKey: `courses/${COURSE}/objects/${'a'.repeat(64)}`, format: 'markdown' },
      accessibleAlternative: { text: 'Plain text version' },
    });
    expect(await screen.findByText('week3')).toBeInTheDocument();
    // The new reading is waiting; the stub reports every resource in the same state.
    expect(await screen.findAllByText('Waiting to be processed')).toHaveLength(2);
  });

  it('A26 refuses an unsupported file before sending it', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { s } = await open();
    await user.click(await screen.findByRole('button', { name: 'Add reading' }));
    const form = screen.getByRole('form', { name: 'Add reading' });
    await user.upload(within(form).getByLabelText(/File/), new File(['MZ'], 'run.exe'));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Upload a Markdown');
    expect(within(form).getByRole('button', { name: 'Add reading' })).toBeDisabled();
    expect(s.uploads).toBe(0);
  });

  it('A26 shows a failed processing job with its reason and a retry', async () => {
    await open(
      grant(),
      fresh({ processing: { state: 'failed', error: 'The file is larger than 50 MB' } }),
    );
    expect(
      await screen.findByText(/Processing failed: The file is larger than 50 MB/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry processing' })).toBeInTheDocument();
  });
});

describe('notebook upload', () => {
  it('A09 adds a notebook from an .ipynb file on the Notebooks tab', async () => {
    const user = userEvent.setup();
    const { s } = await open();
    const notebooks = await screen.findByRole('region', { name: 'Notebooks resources' });
    await user.click(within(notebooks).getByRole('button', { name: 'Add notebook' }));
    const form = screen.getByRole('form', { name: 'Add notebook' });
    await user.upload(
      within(form).getByLabelText(/File/),
      new File(['{"nbformat": 4}'], 'Repeated samples.ipynb', { type: 'application/json' }),
    );
    expect(within(form).getByLabelText('Title')).toHaveValue('Repeated samples');
    await user.click(within(form).getByRole('button', { name: 'Add notebook' }));
    await waitFor(() => expect(s.uploads).toBe(1));
    const created = s.patched.find((p) => p.url.endsWith('/resources'))?.body;
    expect(created).toEqual({
      type: 'notebook',
      title: 'Repeated samples',
      content: { sourceKey: `courses/${COURSE}/objects/${'a'.repeat(64)}` },
      objectKeys: [`courses/${COURSE}/objects/${'a'.repeat(64)}`],
    });
  });

  it('A09 refuses a file that is not a notebook before sending it, and a reading refuses .ipynb', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { s } = await open();
    const notebooks = await screen.findByRole('region', { name: 'Notebooks resources' });
    await user.click(within(notebooks).getByRole('button', { name: 'Add notebook' }));
    const form = screen.getByRole('form', { name: 'Add notebook' });
    await user.upload(within(form).getByLabelText(/File/), new File(['# x'], 'notes.md'));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'Upload a Jupyter notebook (.ipynb) file',
    );
    expect(within(form).getByRole('button', { name: 'Add notebook' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Add reading' }));
    const reading = screen.getByRole('form', { name: 'Add reading' });
    await user.upload(within(reading).getByLabelText(/File/), new File(['{}'], 'lab.ipynb'));
    expect(await within(reading).findByRole('alert')).toHaveTextContent('Upload a Markdown');
    expect(s.uploads).toBe(0);
  });
});

describe('web slides', () => {
  const deck = () =>
    fresh({
      resources: [resource({ type: 'slides_web', title: 'Sampling in slides' })],
      deckMarkdown: '# Sampling\n\n---\n\nSlide two',
    });

  it('adds a deck from Markdown typed into a textarea and shows its processing state', async () => {
    const user = userEvent.setup();
    const { s } = await open();
    const slides = await screen.findByRole('region', { name: 'Slides resources' });
    await user.click(within(slides).getByRole('button', { name: 'Add web slides' }));
    const form = screen.getByRole('form', { name: 'Add web slides' });
    expect(within(form).getByRole('button', { name: 'Add web slides' })).toBeDisabled();
    await user.type(within(form).getByLabelText('Title'), 'Week 3 slides');
    await user.type(within(form).getByLabelText(/Slides \(Markdown\)/), 'One{enter}---{enter}Two');
    await user.click(within(form).getByRole('button', { name: 'Add web slides' }));
    await waitFor(() => expect(s.patched.some((p) => p.url.endsWith('/resources'))).toBe(true));
    expect(s.patched.find((p) => p.url.endsWith('/resources'))?.body).toEqual({
      type: 'slides_web',
      title: 'Week 3 slides',
      content: { markdown: 'One\n---\nTwo' },
    });
    expect(await screen.findByText('Week 3 slides')).toBeInTheDocument();
    expect(await screen.findAllByText('Waiting to be processed')).toHaveLength(2);
  });

  it('edits the Markdown of a deck: only changed Markdown is sent as content, Saved follows the acknowledgement', async () => {
    const user = userEvent.setup();
    const { s } = await open(grant(), deck());
    await user.click(await screen.findByRole('button', { name: 'Edit Sampling in slides' }));
    const markdown = await screen.findByLabelText('Slides (Markdown)');
    expect(markdown).toHaveValue('# Sampling\n\n---\n\nSlide two');
    // A title edit alone makes no new revision.
    await user.type(screen.getByLabelText('Slides title'), '!');
    await waitFor(() => expect(s.patched).toHaveLength(1), { timeout: 4000 });
    expect(s.patched[0]?.body).not.toHaveProperty('content');
    expect(await screen.findByText(/Draft saved at/)).toBeInTheDocument();

    await user.type(markdown, '{enter}---{enter}Slide three');
    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument();
    await waitFor(() => expect(s.patched).toHaveLength(2), { timeout: 4000 });
    expect(s.patched[1]?.body).toMatchObject({
      expectedRevision: 2,
      content: { markdown: '# Sampling\n\n---\n\nSlide two\n---\nSlide three' },
    });
  });

  it('a finished web deck reads Ready to publish', async () => {
    await open(grant(), deck());
    expect(await screen.findByText('Ready to publish')).toBeInTheDocument();
  });
});

describe('deck processing status', () => {
  it('a finished deck reads Processed, not Ready to publish: publication can still need a text alternative', async () => {
    await open(
      grant(),
      fresh({ resources: [resource({ type: 'slides_pdf', title: 'Lecture 1' })] }),
    );
    expect(await screen.findByText('Processed')).toBeInTheDocument();
    expect(screen.queryByText('Ready to publish')).not.toBeInTheDocument();
  });

  it('a finished reading still reads Ready to publish', async () => {
    await open();
    expect(await screen.findByText('Ready to publish')).toBeInTheDocument();
  });
});

describe('processing state while it is not known', () => {
  it('A26 says it is checking while the status loads, and offers no retry for a ready reading', async () => {
    const fetchMock = api(grant(), fresh());
    const gate = hold(fetchMock, (url) => url.endsWith('/processing'));
    renderApp(`/courses/${COURSE}/edit/${TOPIC}`);
    await waitFor(() => expect(gate.held.count).toBe(1));
    expect(await screen.findByText('Checking processing…')).toBeInTheDocument();
    expect(screen.queryByText(/Not processed yet/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry processing' })).toBeNull();
    gate.release();
    expect(await screen.findByText('Ready to publish')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry processing' })).toBeNull();
  });

  it('A26 reports a status that could not be loaded and reloads it instead of retrying processing', async () => {
    const user = userEvent.setup();
    const { s } = await open(grant(), fresh({ processingStatus: 503 }));
    expect(await screen.findByText(/Processing status could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByText(/Not processed yet/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry processing' })).toBeNull();
    s.processingStatus = undefined;
    await user.click(screen.getByRole('button', { name: 'Reload status' }));
    expect(await screen.findByText('Ready to publish')).toBeInTheDocument();
  });

  it('A26 offers Retry processing when the server reported no status', async () => {
    await open(grant(), fresh({ processing: { state: null } }));
    expect(await screen.findByText(/Not processed yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry processing' })).toBeInTheDocument();
  });
});

describe('publishing', () => {
  it('A16 Publish creates the next release and says classes stay on theirs', async () => {
    const user = userEvent.setup();
    const { s } = await open();
    await user.click(await screen.findByRole('button', { name: 'Publish release 3' }));
    expect(await screen.findByText('Release 3 created.')).toBeInTheDocument();
    expect(s.latest).toBe(3);
    // The next publish would be version 4, and Class A is still on release 2.
    expect(await screen.findByRole('button', { name: 'Publish release 4' })).toBeInTheDocument();
    expect(screen.getByText(/Class A uses release 2\./)).toBeInTheDocument();
  });

  it('A16 blocking problems are listed and publishing shows the server report', async () => {
    const user = userEvent.setup();
    const report = {
      errors: [
        { code: 'unprocessed_reading', message: '“Why samples vary” is still being processed' },
      ],
      warnings: [{ code: 'missing_alternative', message: '“Paper” has no accessible alternative' }],
    };
    await open(grant(), fresh({ report, publishStatus: 422 }));
    expect(await screen.findByText(/1 blocking problem/)).toBeInTheDocument();
    expect(screen.getByText('“Why samples vary” is still being processed')).toBeInTheDocument();
    expect(screen.getByText('“Paper” has no accessible alternative')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Publish release 3' }));
    await waitFor(() =>
      expect(
        screen.getAllByText('“Why samples vary” is still being processed').length,
      ).toBeGreaterThan(0),
    );
    expect(screen.queryByText('Release 3 created.')).toBeNull();
  });

  it('A16 says the release was not created because of the listed problems', async () => {
    const user = userEvent.setup();
    const report = {
      errors: [{ code: 'unprocessed_reading', message: '“Why samples vary” is not processed' }],
      warnings: [],
    };
    await open(grant(), fresh({ report, publishStatus: 422 }));
    await user.click(await screen.findByRole('button', { name: 'Publish release 3' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The release was not created because of the blocking problems listed above.',
    );
  });

  it('A16 names the publisher permission when it was revoked and follows the new session', async () => {
    const user = userEvent.setup();
    const me = grant();
    const { s } = await open(me, fresh({ publishStatus: 403 }));
    const button = await screen.findByRole('button', { name: 'Publish release 3' });
    expect(button).toBeEnabled();
    // The grant is withdrawn after the session loaded.
    me.courses = me.courses.map((c) => ({ ...c, publisher: false }));
    await user.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The release was not created. Publishing needs the publisher permission on this course.',
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Publish release 3' })).toBeDisabled(),
    );
    expect(s.latest).toBe(2);
  });

  it('A16 marks an archived class in the release list', async () => {
    await open(grant(), fresh({ classArchived: true }));
    expect(await screen.findByText(/Class A \(archived\) uses release 2\./)).toBeInTheDocument();
  });

  it('A16 an editor without the publisher permission cannot publish and is told why', async () => {
    await open(grant({ publisher: false }));
    expect(await screen.findByRole('button', { name: 'Publish release 3' })).toBeDisabled();
    expect(screen.getByText(/needs the publisher permission/)).toBeInTheDocument();
  });

  it('A16 names a class that has adopted nothing', async () => {
    await open(grant(), fresh({ latest: null, classUses: null }));
    expect(await screen.findByText(/Class A has not adopted a release\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish release 1' })).toBeInTheDocument();
  });
});

describe('publication check stays current', () => {
  it('A16 drops the blocking problems once the drafts are fixed, without another Publish click', async () => {
    const user = userEvent.setup();
    const blocking = {
      errors: [
        { code: 'unprocessed_reading', message: '“Why samples vary” is still being processed' },
      ],
      warnings: [],
    };
    const { s, queryClient } = await open(grant(), fresh({ report: blocking, publishStatus: 422 }));
    await screen.findByText(/1 blocking problem/);
    await user.click(screen.getByRole('button', { name: 'Publish release 3' }));
    await screen.findByText(/1 blocking problem/);
    // The job finished and the editor fixed the draft: the next check is clean.
    s.report = { errors: [], warnings: [] };
    s.processing = { state: 'ready' };
    await queryClient.invalidateQueries({ queryKey: ['authoring'] });
    expect(await screen.findByText(/no blocking problems/)).toBeInTheDocument();
    expect(screen.queryByText('“Why samples vary” is still being processed')).toBeNull();
  });
});

describe('course topics', () => {
  it('A26 a failed reorder puts the first topic back instead of leaving two at one position', async () => {
    const user = userEvent.setup();
    const s = fresh({ otherStatus: 409 });
    api(grant(), s);
    renderApp(`/courses/${COURSE}/edit`);
    await user.click(await screen.findByRole('button', { name: 'Move Sampling later' }));
    await screen.findByText(/Another editor changed the topics/);
    const writes = s.patched.map((p) => `${p.url.slice(-4)}:${p.body.position}`);
    // Sampling (0) swapped to 1, Estimation refused, Sampling restored to 0.
    expect(writes).toEqual([
      `${TOPIC.slice(-4)}:1`,
      `${OTHER.slice(-4)}:0`,
      `${TOPIC.slice(-4)}:0`,
    ]);
  });
});

describe('leaving the editor', () => {
  it('A26 an edit made just before navigating away is still saved', async () => {
    const user = userEvent.setup();
    const { s, router } = await open();
    await user.type(await screen.findByLabelText('Learning objective'), '!');
    expect(s.patched).toHaveLength(0);
    await router.navigate({ to: '/courses/$courseId/edit', params: { courseId: COURSE } });
    await waitFor(() => expect(s.patched).toHaveLength(1));
    expect(s.patched[0]?.body.objective).toBe('Explain why estimates differ.!');
  });
});

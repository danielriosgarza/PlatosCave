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
  uploads: number;
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
            archived: false,
            release: s.classUses ? { id: COURSE, version: s.classUses } : null,
          },
        ],
      });
    }
    if (path === `${base}/processing`) {
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
      if (s.publishStatus === 422) {
        return json({ error: 'validation_failed', report: s.report }, 422);
      }
      s.latest = (s.latest ?? 0) + 1;
      return json({
        release: { id: COURSE, version: s.latest, createdAt: stamp },
        report: s.report,
      });
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
    return json({ error: 'not found' }, 404);
  });
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
    const { s } = await open(grant(), fresh({ topicStatus: 409, conflictWith: theirs }));
    await user.type(await screen.findByLabelText('Title'), '!');
    const conflict = await screen.findByRole(
      'alert',
      { name: 'Editing conflict' },
      { timeout: 3000 },
    );
    await user.click(within(conflict).getByRole('button', { name: 'Use their version' }));
    expect(await screen.findByDisplayValue('Sampling, by Priya')).toBeInTheDocument();
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

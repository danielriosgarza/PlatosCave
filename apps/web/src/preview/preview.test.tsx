import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLASS_A,
  CLASS_B,
  COURSE,
  instructorIn,
  makeMe,
  makeTopics,
  renderApp,
  signedInWithTopics,
  stubApi,
  studentIn,
  T_SAMPLING,
} from '../test/render';
import { leavePage } from './navigate';

vi.mock('./navigate', () => ({ leavePage: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(leavePage).mockReset();
});

const PREVIEW_ID = '00000000-0000-4000-8000-000000000007';
const editor = `/courses/${COURSE}/edit/${T_SAMPLING}`;

/** A draft-preview session: its only usable membership is the preview one in class B. */
const previewMe = makeMe({
  user: { id: PREVIEW_ID, name: 'Preview student', email: null, kind: 'preview' },
  classes: [{ ...studentIn(CLASS_B, 'Autumn 2026 B'), isPreview: true }],
});
const draftTopics = makeTopics({ release: null, cohort: 'Autumn 2026 B' });

describe('draft preview in the web shell', () => {
  it('A26 a preview session opens its preview class with the Exit draft preview banner', async () => {
    stubApi(signedInWithTopics(previewMe, draftTopics));
    renderApp(`/classes/${CLASS_B}/topics/${T_SAMPLING}/reading`);
    expect(await screen.findByRole('heading', { name: 'Sampling' })).toBeInTheDocument();
    const banner = screen.getByRole('region', { name: 'Draft preview' });
    expect(banner).toHaveTextContent(
      'Draft preview · Statistical thinking as a student of Autumn 2026 B.',
    );
    expect(banner).toHaveTextContent('Notes and attempts made here stay out of the class.');
    expect(within(banner).getByRole('button', { name: 'Exit draft preview' })).toBeEnabled();
    // The shell follows the server's rule: a preview session acts through its preview row.
    expect(screen.getByRole('link', { name: 'Topics' })).toHaveAttribute(
      'href',
      `/classes/${CLASS_B}/topics`,
    );
  });

  it('A26 leaving draft preview returns to the instructor editor', async () => {
    const fetchMock = stubApi((url, init) =>
      url === '/api/preview/exit' && init?.method === 'POST'
        ? { status: 200, body: { restored: true, returnTo: editor } }
        : signedInWithTopics(previewMe, draftTopics)(url, init),
    );
    renderApp(`/classes/${CLASS_B}/topics`);
    await userEvent.click(await screen.findByRole('button', { name: 'Exit draft preview' }));
    await waitFor(() => expect(leavePage).toHaveBeenCalledWith(editor));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/preview/exit',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('A26 a failed exit keeps the preview and says so', async () => {
    stubApi((url, init) =>
      url === '/api/preview/exit'
        ? { status: 503, body: { error: 'unavailable' } }
        : signedInWithTopics(previewMe, draftTopics)(url, init),
    );
    renderApp(`/classes/${CLASS_B}/topics`);
    await userEvent.click(await screen.findByRole('button', { name: 'Exit draft preview' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not leave the preview. Try again.',
    );
    expect(leavePage).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Exit draft preview' })).toBeEnabled();
  });

  it('A26 a person’s own preview rows never show as classes, and no banner shows', async () => {
    const me = makeMe({
      classes: [
        instructorIn(CLASS_A, 'Autumn 2026 A'),
        { ...studentIn(CLASS_B, 'Autumn 2026 B'), isPreview: true },
      ],
    });
    stubApi(signedInWithTopics(me));
    renderApp(`/classes/${CLASS_B}/topics/${T_SAMPLING}/reading`);
    expect(
      await screen.findByRole('heading', { name: 'This page is not available' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Draft preview' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Topics' })).toHaveAttribute(
      'href',
      `/classes/${CLASS_A}/topics`,
    );
  });
});

describe('Preview student view in the topic editor', () => {
  const stamp = '2026-10-01T09:00:00.000Z';
  const draftTopic = {
    id: T_SAMPLING,
    courseId: COURSE,
    position: 0,
    title: 'Sampling',
    objective: '',
    prerequisites: [],
    completionRule: null,
    estimatedMinutes: null,
    revision: 1,
    archived: false,
    updatedAt: stamp,
    resources: [
      {
        id: '00000000-0000-4000-8000-0000000000b1',
        courseId: COURSE,
        topicId: T_SAMPLING,
        type: 'reading_native',
        title: 'Why samples vary',
        position: 0,
        visibility: 'visible',
        releaseAt: null,
        headRevisionId: null,
        revision: 1,
        archived: false,
        updatedAt: stamp,
      },
    ],
  };
  const grant = { courseId: COURSE, title: 'Statistical thinking', owner: false, editor: true };

  function editorApi(me: ReturnType<typeof makeMe>, previews: unknown[]) {
    return stubApi((url, init) => {
      if (url === '/api/me') return { status: 200, body: me };
      if (url === `/api/courses/${COURSE}/drafts`) {
        return { status: 200, body: { topics: [draftTopic] } };
      }
      if (url === `/api/courses/${COURSE}/preview` && init?.method === 'POST') {
        previews.push(JSON.parse(String(init.body)));
        return {
          status: 200,
          body: {
            classId: CLASS_B,
            preview: { id: PREVIEW_ID, name: 'Preview student' },
            expiresAt: stamp,
          },
        };
      }
      return { status: 404, body: { error: 'not found' } };
    });
  }

  it('A26 starts the preview of the edited topic in the class the instructor teaches', async () => {
    const previews: unknown[] = [];
    editorApi(
      makeMe({
        classes: [instructorIn(CLASS_B, 'Autumn 2026 B')],
        courses: [{ ...grant, publisher: false }],
      }),
      previews,
    );
    renderApp(editor);
    expect(await screen.findByText('as a student of Autumn 2026 B')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Preview student view' }));
    await waitFor(() =>
      expect(leavePage).toHaveBeenCalledWith(`/classes/${CLASS_B}/topics/${T_SAMPLING}/reading`),
    );
    expect(previews).toEqual([{ classId: CLASS_B, topicId: T_SAMPLING }]);
  });

  it('A26 an editor who teaches no class of the course is told why there is no preview', async () => {
    editorApi(makeMe({ courses: [{ ...grant, owner: true, publisher: true }] }), []);
    renderApp(editor);
    expect(
      await screen.findByText(
        'Student preview opens in a class you teach; you teach no class of this course.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview student view' })).toBeNull();
  });
});

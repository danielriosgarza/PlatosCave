import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { StrictMode } from 'react';
import { vi } from 'vitest';
import { routeTree } from '../routeTree.gen';
import { createQueryClient } from '../session/revocation';
import type { Me } from '../session/useSession';
import type { ClassTopics } from '../topics/topics';

export const SAM_ID = '00000000-0000-4000-8000-000000000004';
export const CLASS_A = '00000000-0000-4000-8000-000000000201';
export const CLASS_B = '00000000-0000-4000-8000-000000000202';
export const COURSE = '00000000-0000-4000-8000-000000000101';

export function makeMe(overrides: Partial<Me> = {}): Me {
  return {
    user: { id: SAM_ID, name: 'Sam Okafor', email: 'sam@example.test', kind: 'user' },
    classes: [],
    courses: [],
    ...overrides,
  };
}

export const studentIn = (classId: string, className: string): Me['classes'][number] => ({
  classId,
  className,
  courseId: COURSE,
  courseTitle: 'Statistical thinking',
  role: 'student',
  manageMembers: false,
  isPreview: false,
});

export const instructorIn = (classId: string, className: string): Me['classes'][number] => ({
  ...studentIn(classId, className),
  role: 'instructor',
});

type Handler = (url: string, init?: RequestInit) => { status: number; body?: unknown };

/** Replaces `fetch` with a stub of the HTTP boundary (the API is exercised for real in e2e). */
export function stubApi(handler: Handler) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const { status, body } = handler(String(input), init);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The cards the API derives from the same memberships, with no topics or study positions. */
export function cardsFor(me: Me) {
  return {
    classes: me.classes
      .filter((c) => !c.isPreview)
      .map((c) => ({
        classId: c.classId,
        className: c.className,
        courseId: c.courseId,
        courseTitle: c.courseTitle,
        role: c.role,
        archived: false,
        topicCount: 0,
        reviewed: { count: 0, total: 0 },
        resume: null,
        studentCount: c.role === 'instructor' ? 0 : null,
      })),
    courses: me.courses.map((c) => ({ ...c, topicCount: 0, classCount: 0 })),
  };
}

export const signedIn =
  (me: Me): Handler =>
  (url) =>
    url === '/api/me'
      ? { status: 200, body: me }
      : url === '/api/courses'
        ? { status: 200, body: cardsFor(me) }
        : { status: 404, body: {} };

export const T_SAMPLING = '00000000-0000-4000-8000-000000000301';
export const T_ESTIMATION = '00000000-0000-4000-8000-000000000302';
export const T_INFERENCE = '00000000-0000-4000-8000-000000000303';

type TopicsBody = ClassTopics;
const presence = (on: string[] = []) => ({
  slides: on.includes('slides'),
  reading: on.includes('reading'),
  exercises: on.includes('exercises'),
  notebooks: on.includes('notebooks'),
  tests: on.includes('tests'),
});

/** `GET /api/classes/:id/topics` for a two-topic syllabus; override any part. */
export function makeTopics(overrides: Partial<TopicsBody> = {}): TopicsBody {
  return {
    release: { id: '00000000-0000-4000-8000-000000000601', version: 1 },
    course: { id: COURSE, title: 'Statistical thinking' },
    cohort: 'Autumn 2026 A',
    instructors: ['Elena Ruiz'],
    topics: [
      {
        topicId: T_SAMPLING,
        number: 1,
        title: 'Sampling',
        objective: 'Separate patterns from variation.',
        estimatedMinutes: 45,
        presence: presence(['reading', 'tests']),
        firstTab: 'reading',
        savedTab: 'tests',
        state: 'available',
        availableAt: null,
        requires: [],
      },
      {
        topicId: T_ESTIMATION,
        number: 2,
        title: 'Estimation',
        objective: '',
        estimatedMinutes: null,
        presence: presence(),
        firstTab: null,
        savedTab: null,
        state: 'locked',
        availableAt: null,
        requires: [{ topicId: T_SAMPLING, title: 'Sampling' }],
      },
    ],
    resume: { topicId: T_SAMPLING, tab: 'tests', saved: true },
    reviewed: { count: 0, total: 2 },
    ...overrides,
  };
}

/** Answers `/api/me` with `me` and every class topic list with `topics`. */
export const signedInWithTopics =
  (me: Me, topics: TopicsBody = makeTopics()): Handler =>
  (url) =>
    url === '/api/me'
      ? { status: 200, body: me }
      : /^\/api\/classes\/[^/]+\/topics$/.test(url)
        ? { status: 200, body: topics }
        : { status: 404, body: {} };

export function renderApp(url: string, { strict = false }: { strict?: boolean } = {}) {
  const queryClient = createQueryClient({ retry: false });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  const app = (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  const view = render(strict ? <StrictMode>{app}</StrictMode> : app);
  return { router, queryClient, ...view };
}

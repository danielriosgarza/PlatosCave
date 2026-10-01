import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { routeTree } from '../routeTree.gen';
import type { Me } from '../session/useSession';

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

export function renderApp(url: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient, ...view };
}

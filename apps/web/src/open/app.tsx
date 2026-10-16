import '@parallax/ui/tokens.css';
import '../styles/global.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  redirect,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { OpenBar } from './OpenBar';
import { OpenUnavailable } from './OpenUnavailable';
import { Topic } from './Topic';

/**
 * The open site's viewer, level 0 (docs/design/open-site.md §6): a router of its own with its own
 * root (the open bar and an outlet) and the topics of the site's courses, read from the build's
 * data files. It holds no session, signs no one in and keeps nothing.
 */

/** `?resource=` picks a resource of the tab, `&page=` a slide. */
const topicSearch = z.object({
  resource: z.coerce.string().optional().catch(undefined),
  page: z.coerce.number().int().min(1).optional().catch(undefined),
});

/** A topic in either mode: `<course>` or `<name>/<course>` is the course reference (§2). */
function TopicScreen() {
  const params = useParams({ strict: false }) as Record<string, string | undefined>;
  const { name, course = '', topicId = '', tab = '' } = params;
  const { resource, page } = useSearch({ strict: false }) as z.output<typeof topicSearch>;
  const ref = name === undefined ? course : `${name}/${course}`;
  return <Topic {...{ course: ref, topicId, tab, resource, page }} />;
}

/** The open site. `/` goes to `/courses`, the catalogue's address (§2). */
export function createOpenApp() {
  const root = createRootRoute({
    component: () => (
      <>
        <OpenBar />
        <Outlet />
      </>
    ),
    notFoundComponent: OpenUnavailable,
  });
  const topic = (path: string) =>
    createRoute({
      getParentRoute: () => root,
      path,
      validateSearch: topicSearch,
      component: TopicScreen,
    });
  const toCourses = createRoute({
    getParentRoute: () => root,
    path: '/',
    beforeLoad: () => {
      throw redirect({ to: '/courses', replace: true });
    },
  });
  root.addChildren([
    toCourses,
    topic('/courses/$course/$topicId/$tab'),
    topic('/courses/$name/$course/$topicId/$tab'),
  ]);

  const queryClient = new QueryClient({
    // The data files do not change while a page is open; a failure offers its own Try again.
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
  });
  const router = createRouter({ routeTree: root });
  const element = (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>
  );
  return { router, element };
}

/** Renders the open site into `root`. */
export function mountOpen(root: HTMLElement) {
  createRoot(root).render(createOpenApp().element);
}

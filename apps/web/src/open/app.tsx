import '@parallax/ui/tokens.css';
import '../styles/global.css';
import { OPEN_ADDRESSES } from '@parallax/contracts';
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
import { type ReactNode, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { RouteFailed } from '../components/RouteFailed';
import { type Site, screenAt, siteRoutes } from '../sitePages';
import { Catalogue, CourseIndex } from './Course';
import { OpenBar } from './OpenBar';
import { OpenUnavailable } from './OpenUnavailable';
import { Topic } from './Topic';

/**
 * The open site's viewer, level 0 (docs/design/open-site.md §6): a router of its own with its own
 * root (the open bar and an outlet), the topics of the site's courses read from the build's data
 * files, and the site's own pages. It holds no session, signs no one in and keeps nothing.
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

/** A course's topic index in either mode. */
function CourseScreen() {
  const { name, course = '' } = useParams({ strict: false }) as Record<string, string | undefined>;
  return <CourseIndex course={name === undefined ? course : `${name}/${course}`} />;
}

/**
 * A page whose module cannot be fetched fails as any other page does (`RouteFailed`): with the
 * browser's message the router would mark it in `sessionStorage` and reload, and the shell keeps
 * nothing in the browser (§6).
 */
const settled = (site: Site): Site => ({
  ...site,
  pages: site.pages.map((page) => ({
    ...page,
    load: () =>
      page.load().catch((cause: unknown) => {
        throw new Error(`The site page ${page.path} could not be loaded.`, { cause });
      }),
  })),
});

/**
 * The open site, with a site's pages below the bar. A page at `/` is the front page; without one
 * `/` goes to `/courses`, the catalogue's address (§2). A page at an address Parallax keeps
 * (`OPEN_ADDRESSES`) is refused.
 */
export function createOpenApp(site?: Site) {
  for (const page of site?.pages ?? []) {
    const kept = screenAt(page.path, OPEN_ADDRESSES);
    if (kept) {
      throw new Error(
        `The site page ${page.path} would be at ${kept}: Parallax keeps /courses and the addresses below it.`,
      );
    }
  }
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
      errorComponent: RouteFailed,
    });
  const screen = (path: string, component: () => ReactNode) =>
    createRoute({ getParentRoute: () => root, path, component, errorComponent: RouteFailed });
  const toCourses = createRoute({
    getParentRoute: () => root,
    path: '/',
    beforeLoad: () => {
      throw redirect({ to: '/courses', replace: true });
    },
  });
  const front = site?.pages.some((page) => page.path === '/');
  root.addChildren([
    ...(front ? [] : [toCourses]),
    screen('/courses', Catalogue),
    screen('/courses/$course', CourseScreen),
    screen('/courses/$name/$course', CourseScreen),
    topic('/courses/$course/$topicId/$tab'),
    topic('/courses/$name/$course/$topicId/$tab'),
    ...(site ? siteRoutes(root, settled(site)) : []),
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

/** Renders the open site into `root`, with the site's pages when a site gives them. */
export function mountOpen(root: HTMLElement, site?: Site) {
  createRoot(root).render(createOpenApp(site).element);
}

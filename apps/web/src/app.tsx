import '@parallax/ui/tokens.css';
import './styles/global.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { type AnyRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Route as IndexRoute } from './routes/index';
import { routeTree } from './routeTree.gen';
import { createQueryClient } from './session/revocation';
import { cleanPath, normalise, type Site, screenAt, siteRoutes } from './sitePages';

/** The root's children as generated, read once: every call of `createApp` starts from them. */
const kept = routeTree.children as unknown as readonly AnyRoute[];

/** The address of every route with a path, as its file names it (`/classes/$classId/review`). */
function addresses(routes: readonly AnyRoute[], base: string): string[] {
  return routes.flatMap((route) => {
    const { path } = route.options as { path?: string };
    const full = path === undefined ? base : cleanPath(`${base}/${path}`);
    const below = addresses((route.children ?? []) as AnyRoute[], full);
    return path === undefined ? below : [full, ...below];
  });
}
const screens = addresses(kept, '/');

/**
 * The web application, with a site's pages added beside its screens (docs/design/site.md §6.1).
 * Without pages it is the application as generated, and `/` redirects as before; a page at `/`
 * takes the place of that redirect. A page at the address of any other screen is refused.
 */
export function createApp(site?: Site) {
  const pages = site?.pages ?? [];
  for (const page of pages) {
    const screen = normalise(page.path) === '/' ? undefined : screenAt(page.path, screens);
    if (screen) {
      throw new Error(
        `The site page ${page.path} would be at ${screen}, the address of a Parallax screen. A site adds pages and cannot replace a Parallax screen.`,
      );
    }
  }
  const front = pages.some((page) => normalise(page.path) === '/');
  const children = front ? kept.filter((route) => route !== IndexRoute) : kept;
  routeTree.addChildren(site ? [...children, ...siteRoutes(routeTree, site)] : [...kept]);

  const queryClient = createQueryClient();
  const router = createRouter({ routeTree, context: { queryClient } });
  const element = (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>
  );
  return { router, queryClient, element };
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createApp>['router'];
  }
}

/** Renders the application into `root`, with the site's pages when a site gives them. */
export function mount(root: HTMLElement, site?: Site) {
  createRoot(root).render(createApp(site).element);
}

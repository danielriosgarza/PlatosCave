import '@parallax/ui/tokens.css';
import './styles/global.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { type AnyRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Route as IndexRoute } from './routes/index';
import { routeTree } from './routeTree.gen';
import { createQueryClient } from './session/revocation';
import { cleanPath, isPageAddress, normalise, type Site, screenAt, siteRoutes } from './sitePages';

/**
 * The root's children as generated, read once: every call of `createApp` starts from them. There
 * is one tree, so a call replaces the pages of the one before; only the newest app's tree holds.
 */
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

/** Why a page cannot be added, naming it; `undefined` when it can. */
function refusal(path: string, earlier: ReadonlySet<string>): string | undefined {
  const screen = normalise(path) === '/' ? undefined : screenAt(path, screens);
  if (screen) {
    return `The site page ${path} would be at ${screen}, the address of a Parallax screen. A site adds pages and cannot replace a Parallax screen.`;
  }
  if (!isPageAddress(path)) {
    return `The site page "${path}" has no page address: "/", or segments of lower-case letters, digits and hyphens.`;
  }
  if (earlier.has(path)) return `Two site pages are at ${path}.`;
}

/**
 * The web application, with a site's pages added beside its screens (docs/design/site.md §6.1).
 * Without pages it is the application as generated, and `/` redirects as before; a page at `/`
 * takes the place of that redirect. A page at the address of any other screen, a path that is
 * not a page address and a second page at one address are refused before the tree changes.
 */
export function createApp(site?: Site) {
  const pages = site?.pages ?? [];
  const earlier = new Set<string>();
  for (const page of pages) {
    const reason = refusal(page.path, earlier);
    if (reason) throw new Error(reason);
    earlier.add(page.path);
  }
  const front = earlier.has('/');
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

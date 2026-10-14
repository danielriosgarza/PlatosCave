import type { AnyRoute } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app';
import { routeTree } from './routeTree.gen';
import { Link, type PageProps, type Site } from './sitePages';
import { CLASS_A, makeMe, signedIn, stubApi, studentIn } from './test/render';

/** The root's children as generated, before any `createApp` of this file. */
const generated = [...(routeTree.children as unknown as AnyRoute[])];
const children = () => routeTree.children as unknown as AnyRoute[];
const at = (path: string) =>
  children().filter((route) => (route.options as { path?: string }).path === path);
/** True when the root holds exactly these routes, in this order. */
const holds = (routes: AnyRoute[]) =>
  children().length === routes.length && children().every((route, i) => route === routes[i]);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const signedOut = () => ({ status: 401, body: { error: 'unauthenticated' } });
const props: PageProps = {
  site: { name: 'Riverside School', entry: '/courses' },
  catalogue: { instructors: [] },
};

/** A site with one page per address, each showing its heading, the site's name and a link. */
function site(pages: Record<string, string>, title?: string): Site {
  return {
    props,
    pages: Object.entries(pages).map(([path, heading]) => ({
      path,
      load: async () => ({
        title,
        default: ({ site: { name } }: PageProps) => (
          <main id="main">
            <h1>{heading}</h1>
            <p>{name}</p>
            <Link to="/about">About the school</Link>
          </main>
        ),
      }),
    })),
  };
}

function open(url: string, withSite?: Site) {
  window.history.replaceState(null, '', url);
  const app = createApp(withSite);
  render(app.element);
  return app;
}

describe('createApp', () => {
  it('without site pages sends a signed-out visitor at / to /signin', async () => {
    stubApi(signedOut);
    const { router } = open('/');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/signin');
  });

  it('without site pages sends a signed-in person at / to /courses', async () => {
    stubApi(signedIn(makeMe({ classes: [studentIn(CLASS_A, 'Class A')] })));
    const { router } = open('/');
    expect(await screen.findByRole('heading', { name: 'Your courses' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/courses');
  });

  it('with pages but none at / keeps the redirect at /', async () => {
    stubApi(signedOut);
    const { router } = open('/', site({ '/about': 'About' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/signin');
  });

  it('shows a page at / with no redirect, and its link opens another page', async () => {
    stubApi(signedOut);
    const { router } = open('/', site({ '/': 'Welcome', '/about': 'About' }));
    expect(await screen.findByRole('heading', { name: 'Welcome' })).toBeInTheDocument();
    expect(screen.getByText('Riverside School')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
    await userEvent.click(screen.getByRole('link', { name: 'About the school' }));
    expect(await screen.findByRole('heading', { name: 'About' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/about');
  });

  it('shows a page at /about inside the root layout, and /signin still shows the sign-in screen', async () => {
    stubApi(signedOut);
    const { router } = open('/about', site({ '/about': 'About' }));
    expect(await screen.findByRole('heading', { name: 'About' })).toBeInTheDocument();
    expect(screen.getByRole('banner')).toContainElement(
      screen.getByRole('link', { name: 'Parallax' }),
    );
    await router.navigate({ to: '/signin' });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'About' })).not.toBeInTheDocument();
  });

  it('sets the title a page exports while the page is shown', async () => {
    stubApi(signedOut);
    const { router } = open('/about', site({ '/about': 'About' }, 'About the school'));
    await waitFor(() => expect(document.title).toBe('About the school · Parallax'));
    await router.navigate({ to: '/signin' });
    await waitFor(() => expect(document.title).toBe('Sign in · Parallax'));
  });

  it('refuses a page at the address of a Parallax screen, naming both', () => {
    const before = [...children()];
    const cases = [
      ['/courses', '/courses'],
      ['/courses/', '/courses'],
      ['/%63ourses', '/courses'],
      ['/classes/x/review', '/classes/$classId/review'],
      ['/signin', '/signin'],
    ];
    for (const [page, screenAddress] of cases) {
      expect(() => createApp(site({ [page as string]: 'Taken' }))).toThrow(
        `The site page ${page} would be at ${screenAddress}, the address of a Parallax screen.`,
      );
    }
    expect(holds(before)).toBe(true);
  });

  it('holds each page once after a second call, and gives the generated tree again without pages', async () => {
    const pages = site({ '/': 'Welcome', '/about': 'About' });
    createApp(pages);
    createApp(pages);
    expect(children()).toHaveLength(generated.length + 1);
    expect(at('/about')).toHaveLength(1);
    expect(at('/')).toHaveLength(1);

    stubApi(signedOut);
    const { router } = open('/');
    expect(holds(generated)).toBe(true);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/signin');
  });
});

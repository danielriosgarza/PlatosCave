import type { AnyRoute } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app';
import { routeTree } from './routeTree.gen';
import { Link, type PageProps, type Site, type SitePage } from './sitePages';
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
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
  document.title = 'Parallax';
  // Each test starts from the generated tree, whatever the one before added to it.
  routeTree.addChildren([...generated]);
});

const signedOut = () => ({ status: 401, body: { error: 'unauthenticated' } });
const props: PageProps = {
  site: { name: 'Riverside School', entry: '/courses' },
  catalogue: { instructors: [] },
};

/** A site with one page per address, each showing its heading, the site's name and two links. */
function site(pages: Record<string, string>, titles: Record<string, string> = {}): Site {
  return {
    props,
    pages: Object.entries(pages).map(([path, heading]) => ({
      path,
      load: async () => ({
        title: titles[path],
        default: ({ site: { name, entry } }: PageProps) => (
          <main id="main">
            <h1>{heading}</h1>
            <p>{name}</p>
            <Link to="/about">About the school</Link>
            <Link to={entry}>Open the courses</Link>
          </main>
        ),
      }),
    })),
  };
}

const aboutPage = (load: SitePage['load']): Site => ({ props, pages: [{ path: '/about', load }] });

async function expectRouteFailed() {
  expect(await screen.findByText('This page could not be shown.')).toBeInTheDocument();
  expect(screen.getByRole('banner')).toContainElement(
    screen.getByRole('link', { name: 'Parallax' }),
  );
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

  it('shows a page at / with no redirect, and its links open another page and a Parallax screen', async () => {
    stubApi(signedIn(makeMe({ classes: [studentIn(CLASS_A, 'Class A')] })));
    const { router } = open('/', site({ '/': 'Welcome', '/about': 'About' }));
    expect(await screen.findByRole('heading', { name: 'Welcome' })).toBeInTheDocument();
    expect(screen.getByText('Riverside School')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
    await userEvent.click(screen.getByRole('link', { name: 'About the school' }));
    expect(await screen.findByRole('heading', { name: 'About' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/about');
    await userEvent.click(screen.getByRole('link', { name: 'Open the courses' }));
    expect(await screen.findByRole('heading', { name: 'Your courses' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/courses');
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

  it('sets the title a page exports while the page is shown, and restores it when it is left', async () => {
    stubApi(signedOut);
    const pages = site({ '/': 'Welcome', '/about': 'About' }, { '/about': 'About the school' });
    open('/about', pages);
    await waitFor(() => expect(document.title).toBe('About the school · Parallax'));
    await userEvent.click(screen.getByRole('link', { name: 'Parallax' }));
    expect(await screen.findByRole('heading', { name: 'Welcome' })).toBeInTheDocument();
    expect(document.title).toBe('Parallax');
  });

  it('keeps the global bar and offers Try again when a page cannot be loaded', async () => {
    stubApi(signedOut);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const page = site({ '/about': 'About' }).pages[0] as SitePage;
    const load = vi.fn(page.load).mockRejectedValueOnce(new Error('chunk gone'));
    open('/about', aboutPage(load));
    await expectRouteFailed();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'About' })).toBeInTheDocument();
  });

  it('keeps the global bar and offers Try again when a page fails to render', async () => {
    stubApi(signedOut);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = () => {
      throw new Error('broken page');
    };
    open(
      '/about',
      aboutPage(async () => ({ default: broken })),
    );
    await expectRouteFailed();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
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

  it('refuses a path that is not a page address and two pages at one address, naming them', () => {
    for (const path of ['', 'about', '/About', '/team/$id', '/about/']) {
      expect(() => createApp(site({ [path]: 'Odd' }))).toThrow(
        `The site page "${path}" has no page address`,
      );
    }
    const twice = site({ '/about': 'About' });
    twice.pages.push(...site({ '/about': 'About again' }).pages);
    expect(() => createApp(twice)).toThrow('Two site pages are at /about.');
    expect(holds(generated)).toBe(true);
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

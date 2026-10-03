import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLASS_A,
  cardsFor,
  instructorIn,
  makeMe,
  renderApp,
  signedIn,
  signedInWithTopics,
  stubApi,
  studentIn,
  T_SAMPLING,
} from '../test/render';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GlobalBar', () => {
  it('A02 links to Courses and to the topics of the class being viewed when signed in', async () => {
    stubApi(signedIn(makeMe({ classes: [studentIn(CLASS_A, 'Class A')] })));
    renderApp('/courses');
    expect(await screen.findByRole('link', { name: 'Courses' })).toHaveAttribute(
      'href',
      '/courses',
    );
    expect(screen.getByRole('link', { name: 'Parallax' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Topics' })).toHaveAttribute(
      'href',
      `/classes/${CLASS_A}/topics`,
    );
    // Off a topic route there is no neighbour, so no empty landmark is rendered (P1-AUD11).
    expect(screen.queryByRole('navigation', { name: 'Neighbouring topics' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('A02 offers only Sign in when nobody is signed in', async () => {
    stubApi(() => ({ status: 401, body: { error: 'unauthenticated' } }));
    renderApp('/signin');
    expect(await screen.findByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/signin');
    expect(screen.queryByRole('link', { name: 'Courses' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('A02 shows Topics for an instructor-only account too', async () => {
    stubApi(signedIn(makeMe({ classes: [instructorIn(CLASS_A, 'Class A')] })));
    renderApp('/courses');
    expect(await screen.findByRole('link', { name: 'Topics' })).toBeInTheDocument();
  });

  it('A02 keeps the person signed in and says so when sign-out fails on the server', async () => {
    const user = userEvent.setup();
    const me = makeMe({ classes: [studentIn(CLASS_A, 'Class A')] });
    stubApi((url) =>
      url === '/api/me'
        ? { status: 200, body: me }
        : url === '/api/courses'
          ? { status: 200, body: cardsFor(me) }
          : { status: 500, body: { error: 'boom' } },
    );
    const { router } = renderApp('/courses');
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-out failed. Try again.');
    expect(router.state.location.pathname).toBe('/courses');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('A02 signs out and returns to /signin once the server confirms', async () => {
    const user = userEvent.setup();
    stubApi((url) =>
      url === '/api/auth/signout'
        ? { status: 200, body: { signedOut: true } }
        : { status: 200, body: makeMe({ classes: [studentIn(CLASS_A, 'Class A')] }) },
    );
    const { router } = renderApp('/courses');
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/signin'));
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(screen.queryByText('Sam Okafor')).toBeNull();
  });

  it('A19 puts the primary links in a labelled Primary landmark, signed in and signed out', async () => {
    stubApi(signedIn(makeMe({ classes: [studentIn(CLASS_A, 'Class A')] })));
    renderApp('/courses');
    const primary = await screen.findByRole('navigation', { name: 'Primary' });
    expect(within(primary).getByRole('link', { name: 'Courses' })).toBeInTheDocument();
    expect(within(primary).getByRole('link', { name: 'Topics' })).toBeInTheDocument();
    cleanup();
    stubApi(() => ({ status: 401, body: { error: 'unauthenticated' } }));
    renderApp('/signin');
    const signedOut = await screen.findByRole('navigation', { name: 'Primary' });
    expect(within(signedOut).getByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Neighbouring topics' })).toBeNull();
  });

  it('A19 offers a Skip to content link that moves focus to the main region', async () => {
    const user = userEvent.setup();
    stubApi(signedIn(makeMe({ classes: [studentIn(CLASS_A, 'Class A')] })));
    renderApp('/courses');
    await screen.findByRole('navigation', { name: 'Primary' });
    await user.tab();
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(skip).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('A19 sets the document title per route', async () => {
    stubApi(() => ({ status: 401, body: { error: 'unauthenticated' } }));
    renderApp('/signin');
    await screen.findByRole('heading', { name: 'Sign in' });
    await waitFor(() => expect(document.title).toBe('Sign in · Parallax'));
    cleanup();
    expect(document.title).toBe('Parallax');

    const me = makeMe({ classes: [studentIn(CLASS_A, 'Class A')] });
    stubApi(signedIn(me));
    renderApp('/courses');
    await screen.findByRole('heading', { name: 'Your courses' });
    await waitFor(() => expect(document.title).toBe('Your courses · Parallax'));
    cleanup();

    stubApi(signedInWithTopics(me));
    renderApp(`/classes/${CLASS_A}/topics`);
    await screen.findByRole('heading', { name: 'Statistical thinking' });
    await waitFor(() => expect(document.title).toBe('Statistical thinking · Parallax'));
    cleanup();

    stubApi(signedInWithTopics(me));
    renderApp(`/classes/${CLASS_A}/topics/${T_SAMPLING}/reading`);
    await screen.findByRole('heading', { name: 'Sampling' });
    await waitFor(() => expect(document.title).toBe('Sampling · Parallax'));
    expect(
      await screen.findByRole('navigation', { name: 'Neighbouring topics' }),
    ).toBeInTheDocument();
  });
});

import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLASS_A,
  instructorIn,
  makeMe,
  renderApp,
  signedIn,
  stubApi,
  studentIn,
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
    expect(screen.getByRole('navigation', { name: 'Neighbouring topics' })).toBeInTheDocument();
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
    stubApi((url) =>
      url === '/api/me'
        ? { status: 200, body: makeMe({ classes: [studentIn(CLASS_A, 'Class A')] }) }
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
});

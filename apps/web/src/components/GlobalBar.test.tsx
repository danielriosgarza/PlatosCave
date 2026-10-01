import { cleanup, screen } from '@testing-library/react';
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
  it('links to Courses and to the topics of the class being viewed when signed in', async () => {
    stubApi(signedIn(makeMe({ classes: [studentIn(CLASS_A, 'Class A')] })));
    renderApp('/courses');
    expect(await screen.findByRole('link', { name: 'Courses' })).toHaveAttribute(
      'href',
      '/courses',
    );
    expect(screen.getByRole('link', { name: 'Topics' })).toHaveAttribute(
      'href',
      `/classes/${CLASS_A}/topics`,
    );
    expect(screen.getByRole('navigation', { name: 'Neighbouring topics' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('offers only Sign in when nobody is signed in', async () => {
    stubApi(() => ({ status: 401, body: { error: 'unauthenticated' } }));
    renderApp('/signin');
    expect(await screen.findByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/signin');
    expect(screen.queryByRole('link', { name: 'Courses' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('shows Topics for an instructor-only account too', async () => {
    stubApi(signedIn(makeMe({ classes: [instructorIn(CLASS_A, 'Class A')] })));
    renderApp('/courses');
    expect(await screen.findByRole('link', { name: 'Topics' })).toBeInTheDocument();
  });
});

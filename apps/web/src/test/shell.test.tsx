import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLASS_A,
  CLASS_B,
  instructorIn,
  makeMe,
  renderApp,
  signedIn,
  signedInWithTopics,
  stubApi,
  studentIn,
  T_SAMPLING,
} from './render';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const signedOut = () => ({ status: 401, body: { error: 'unauthenticated' } });

describe('session redirect', () => {
  it('A01 sends a signed-out visitor to /signin with the destination preserved', async () => {
    stubApi(signedOut);
    const { router } = renderApp(`/classes/${CLASS_A}/topics?x=1`);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/signin');
    expect(router.state.location.search).toEqual({ next: `/classes/${CLASS_A}/topics?x=1` });
  });

  it('A01 sends a signed-out visitor at / to /signin', async () => {
    stubApi(signedOut);
    const { router } = renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/signin');
    expect(router.state.location.search).toEqual({});
  });

  it('A01 offers Retry at / when the session cannot be checked', async () => {
    stubApi(() => ({ status: 500, body: { error: 'unavailable' } }));
    renderApp('/');
    expect(
      await screen.findByText('Your session could not be checked, so this page is not shown.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('A02 sends a signed-in person at / to their courses', async () => {
    stubApi(signedIn(makeMe({ classes: [studentIn(CLASS_A, 'Class A')], courses: [] })));
    const { router } = renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Your courses' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/courses');
  });

  it('A01 shows a class address to a non-member as the neutral unavailable page', async () => {
    stubApi(signedIn(makeMe({ classes: [studentIn(CLASS_B, 'Class B')] })));
    renderApp(`/classes/${CLASS_A}/topics`);
    expect(
      await screen.findByRole('heading', { name: 'This page is not available' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Statistical thinking')).toBeNull();
  });

  it('A01 does not show class review to a student', async () => {
    stubApi(signedIn(makeMe({ classes: [studentIn(CLASS_A, 'Class A')] })));
    renderApp(`/classes/${CLASS_A}/review`);
    expect(
      await screen.findByRole('heading', { name: 'This page is not available' }),
    ).toBeInTheDocument();
  });
});

describe('courses contexts', () => {
  it('A01 explains to a student on the instructor view that there is no instructor access', async () => {
    stubApi(signedIn(makeMe({ classes: [studentIn(CLASS_A, 'Class A')] })));
    renderApp('/courses?view=instructor');
    expect(await screen.findByRole('heading', { name: 'Courses you teach' })).toBeInTheDocument();
    expect(screen.getByText('This account has no instructor access')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Class A/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Class review' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Instructor view' })).toBeNull();
  });

  it('A02 a person teaching class A and studying in class B sees each context separately', async () => {
    const user = userEvent.setup();
    stubApi(
      signedIn(
        makeMe({
          classes: [instructorIn(CLASS_A, 'Class A'), studentIn(CLASS_B, 'Class B')],
          courses: [],
        }),
      ),
    );
    renderApp('/courses');
    expect(await screen.findByRole('heading', { name: 'Your courses' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Class B/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Class A/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Class review' })).toBeNull();

    await user.click(screen.getByRole('link', { name: 'Instructor view' }));
    expect(await screen.findByRole('heading', { name: 'Courses you teach' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Class A/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Class review' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Class B/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Instructor view' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

describe('courses default view', () => {
  it('A02 an instructor-only account opening /courses sees the classes it teaches', async () => {
    stubApi(signedIn(makeMe({ classes: [instructorIn(CLASS_A, 'Class A')] })));
    renderApp('/courses');
    expect(await screen.findByRole('heading', { name: 'Courses you teach' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Class A/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Class review' })).toBeNull();
  });
});

describe('session changes while a page is open', () => {
  const me = makeMe({ classes: [studentIn(CLASS_A, 'Class A')] });
  const handler = { current: signedInWithTopics(me) };

  it('A02 keeps the page and Sign out when a background re-check of the session fails', async () => {
    handler.current = signedInWithTopics(me);
    stubApi((url, init) => handler.current(url, init));
    const { queryClient } = renderApp(`/classes/${CLASS_A}/topics`);
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    handler.current = () => ({ status: 500, body: { error: 'boom' } });
    await queryClient.invalidateQueries({ queryKey: ['session'] });
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Statistical thinking' })).toBeInTheDocument();
    expect(screen.queryByText('This page is not available')).toBeNull();
  });

  it('A01 sends the person to /signin with the address kept when the session ends', async () => {
    handler.current = signedInWithTopics(me);
    stubApi((url, init) => handler.current(url, init));
    const { router, queryClient } = renderApp('/courses?view=student');
    await screen.findByRole('heading', { name: 'Your courses' });
    handler.current = signedOut;
    await queryClient.invalidateQueries({ queryKey: ['session'] });
    await waitFor(() => expect(router.state.location.pathname).toBe('/signin'));
    expect(router.state.location.search).toEqual({ next: '/courses?view=student' });
  });
});

describe('topic workspace tabs', () => {
  it('A02 selecting a tab changes the address and the selected tab', async () => {
    const user = userEvent.setup();
    stubApi(signedInWithTopics(makeMe({ classes: [studentIn(CLASS_A, 'Class A')] })));
    const { router } = renderApp(`/classes/${CLASS_A}/topics/${T_SAMPLING}/slides`);
    const slides = await screen.findByRole('tab', { name: 'Slides' });
    expect(slides).toHaveAttribute('aria-selected', 'true');
    slides.focus();
    await user.keyboard('{ArrowRight}');
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `/classes/${CLASS_A}/topics/${T_SAMPLING}/reading`,
      ),
    );
    expect(screen.getByRole('tab', { name: 'Reading' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Reading');
  });

  it('A02 an unknown tab in the address lands on Slides', async () => {
    stubApi(signedInWithTopics(makeMe({ classes: [studentIn(CLASS_A, 'Class A')] })));
    const { router } = renderApp(`/classes/${CLASS_A}/topics/${T_SAMPLING}/nonsense`);
    await screen.findByRole('tab', { name: 'Slides' });
    expect(router.state.location.pathname).toBe(`/classes/${CLASS_A}/topics/${T_SAMPLING}/slides`);
  });
});

describe('sign-in page', () => {
  it('A01 requests a link for the chosen entrance with the preserved destination, then shows the sent state', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi((url) =>
      url === '/api/auth/link' ? { status: 202, body: { accepted: true } } : signedOut(),
    );
    renderApp('/signin?next=%2Fcourses%3Fview%3Dinstructor');
    await user.click(await screen.findByRole('button', { name: 'Instructor sign in' }));
    expect(screen.getByRole('button', { name: 'Instructor sign in' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.type(screen.getByLabelText('Email address'), 'sam@example.test');
    await user.click(screen.getByRole('button', { name: 'Send sign-in link' }));
    expect(await screen.findByText('Sign-in link requested')).toBeInTheDocument();
    expect(screen.getByText(/sam@example\.test/)).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([url]) => String(url) === '/api/auth/link');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      email: 'sam@example.test',
      entrance: 'instructor',
      next: '/courses?view=instructor',
    });
  });

  it('A01 does not claim a link was requested when the request fails', async () => {
    const user = userEvent.setup();
    stubApi((url) =>
      url === '/api/auth/link' ? { status: 429, body: { error: 'too many' } } : signedOut(),
    );
    renderApp('/signin');
    await user.type(await screen.findByLabelText('Email address'), 'sam@example.test');
    await user.click(screen.getByRole('button', { name: 'Send sign-in link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be requested');
    expect(screen.queryByText('Sign-in link requested')).toBeNull();
  });

  it('A01 shows the expired-link state with the form still available', async () => {
    stubApi(signedOut);
    renderApp('/signin?link=expired');
    expect(await screen.findByText('This sign-in link no longer works')).toBeInTheDocument();
    expect(screen.getByLabelText('Email address')).toBeInTheDocument();
  });

  it('A01 does not show the expired-link state again after a link was requested and the address is changed', async () => {
    const user = userEvent.setup();
    stubApi((url) =>
      url === '/api/auth/link' ? { status: 202, body: { accepted: true } } : signedOut(),
    );
    renderApp('/signin?link=expired');
    expect(await screen.findByText('This sign-in link no longer works')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Email address'), 'sam@example.test');
    await user.click(screen.getByRole('button', { name: 'Send sign-in link' }));
    expect(await screen.findByText('Sign-in link requested')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use a different address' }));
    expect(await screen.findByLabelText('Email address')).toBeInTheDocument();
    expect(screen.queryByText('This sign-in link no longer works')).toBeNull();
  });
});

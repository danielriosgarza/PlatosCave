import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from './axe';
import { renderApp, stubApi } from './render';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const university = { id: 'university', name: 'Example University' };
const hospital = { id: 'hospital', name: 'Example Hospital' };
type Methods = { email: boolean; providers: { id: string; name: string }[] };

/** A signed-out browser; the methods request gets `methods`, or that status when a number. */
const signedOutWith = (methods: Methods | number) =>
  stubApi((url) =>
    url !== '/api/auth/methods'
      ? { status: 401, body: { error: 'unauthenticated' } }
      : typeof methods === 'number'
        ? { status: methods, body: { error: 'unauthenticated' } }
        : { status: 200, body: methods },
  );

/** Renders the page at `url` and returns its `main` once the sign-in methods were read. */
async function signInPage(url: string) {
  renderApp(url);
  await screen.findByRole('heading', { name: 'Sign in' });
  return screen.getByRole('main');
}

const providerLinks = (main: HTMLElement) =>
  within(main).queryAllByRole('link', { name: /^Sign in with / });

describe('sign-in providers', () => {
  it('A47 shows a button for each configured provider that starts its sign-in with the entrance and the kept destination', async () => {
    const user = userEvent.setup();
    signedOutWith({ email: true, providers: [university, hospital] });
    const main = await signInPage('/signin?next=%2Fcourses%3Fview%3Dinstructor');
    expect(providerLinks(main).map((link) => link.textContent)).toEqual([
      'Sign in with Example University',
      'Sign in with Example Hospital',
    ]);
    const first = within(main).getByRole('link', { name: 'Sign in with Example University' });
    const start = '/api/auth/oidc/university/start';
    const next = 'next=%2Fcourses%3Fview%3Dinstructor';
    expect(first).toHaveAttribute('href', `${start}?entrance=student&${next}`);
    await user.click(screen.getByRole('button', { name: 'Instructor sign in' }));
    expect(first).toHaveAttribute('href', `${start}?entrance=instructor&${next}`);
    expect(screen.getByLabelText('Email address')).toBeInTheDocument();
    await expectNoAxeViolations(main);
  });

  it('A47 offers no email form and requests no link when no mail sender is configured', async () => {
    const fetchMock = signedOutWith({ email: false, providers: [university] });
    const main = await signInPage('/signin?link=expired');
    expect(within(main).getByRole('button', { name: 'Student sign in' })).toBeInTheDocument();
    expect(within(main).getByRole('button', { name: 'Instructor sign in' })).toBeInTheDocument();
    expect(providerLinks(main)).toHaveLength(1);
    expect(screen.queryByLabelText('Email address')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send sign-in link' })).toBeNull();
    expect(screen.queryByText('This sign-in link no longer works')).toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain('/api/auth/link');
    await expectNoAxeViolations(main);
  });

  it('A47 with no provider configured the sign-in page is the email page and ignores provider parameters', async () => {
    const url = '/signin?provider=university&refused=unverified';
    const fetchMock = signedOutWith({ email: true, providers: [] });
    const main = await signInPage(url);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain('/api/auth/methods');
    const names = (role: 'heading' | 'button' | 'textbox' | 'link') =>
      within(main)
        .queryAllByRole(role)
        .map((element) => element.textContent || element.getAttribute('name'));
    expect(names('heading')).toEqual(['Sign in']);
    expect(names('button')).toEqual(['Student sign in', 'Instructor sign in', 'Send sign-in link']);
    expect(names('textbox')).toEqual(['email']);
    expect(names('link')).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
    const markup = main.innerHTML;

    // A methods request that fails gives today's page, which shell.test.tsx checks.
    cleanup();
    signedOutWith(401);
    expect((await signInPage(url)).innerHTML).toBe(markup);
  });

  it('A47 explains a refused provider sign-in on the sign-in page', async () => {
    signedOutWith({ email: true, providers: [university] });
    let main = await signInPage('/signin?provider=university&refused=unverified&next=%2Fcourses');
    let alert = within(main).getByRole('alert');
    expect(within(alert).getByRole('heading')).toHaveTextContent(
      'Example University did not confirm an email address',
    );
    expect(alert).toHaveTextContent(
      'Parallax signs you in to the account of a confirmed email address. Example University did not send one, so this sign-in was refused.',
    );
    expect(alert).toHaveTextContent('You can ask for an email link below.');
    expect(providerLinks(main)[0]).toHaveAttribute(
      'href',
      '/api/auth/oidc/university/start?entrance=student&next=%2Fcourses',
    );
    await expectNoAxeViolations(main);

    // Without email links the explanation does not point to them.
    cleanup();
    signedOutWith({ email: false, providers: [university] });
    main = await signInPage('/signin?provider=university&refused=unverified');
    expect(within(main).getByRole('alert')).not.toHaveTextContent('email link');

    cleanup();
    signedOutWith({ email: true, providers: [university] });
    main = await signInPage('/signin?provider=university&refused=failed&next=%2Fcourses');
    alert = within(main).getByRole('alert');
    expect(within(alert).getByRole('heading')).toHaveTextContent(
      'Signing in with Example University did not finish',
    );
    expect(alert).toHaveTextContent('Nothing was changed. Try again.');
    expect(providerLinks(main)[0]?.getAttribute('href')).toContain('next=%2Fcourses');
    await expectNoAxeViolations(main);
  });
});

import {
  listSignInMethods,
  providerId,
  requestSignInLink,
  signInMethods,
} from '@parallax/contracts/routes/auth';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import type { z } from 'zod';
import { call } from '../api/client';
import buttons from '../components/Buttons.module.css';
import styles from '../components/Page.module.css';
import { usePageTitle } from '../components/pageTitle';

type Entrance = 'student' | 'instructor';

interface SignInSearch {
  next?: string;
  link?: 'expired';
  /** Set by a provider's callback that refused the sign-in (ADR-0002, Identity providers). */
  provider?: string;
  refused?: 'unverified' | 'failed';
}

type Methods = z.output<typeof signInMethods>;
const EMAIL_ONLY: Methods = { email: true, providers: [] };

/**
 * A plain `fetch`, not `call()`: a 401 or 404 there would make the session layer re-read
 * `/api/me`. Any failure gives the page with email links only, as before providers existed.
 */
async function readMethods(): Promise<Methods> {
  try {
    const res = await fetch(listSignInMethods.path, { credentials: 'same-origin' });
    return res.ok ? signInMethods.parse(await res.json()) : EMAIL_ONLY;
  } catch {
    return EMAIL_ONLY;
  }
}

export const Route = createFileRoute('/signin')({
  validateSearch: (search: Record<string, unknown>): SignInSearch => ({
    next: typeof search.next === 'string' && search.next ? search.next : undefined,
    link: search.link === 'expired' ? 'expired' : undefined,
    provider: providerId.safeParse(search.provider).data,
    refused:
      search.refused === 'unverified' || search.refused === 'failed' ? search.refused : undefined,
  }),
  loader: () => readMethods(),
  component: SignIn,
});

const ABOUT: Record<Entrance, string> = {
  student: 'Open enrolled courses and resume your work.',
  instructor: 'Open courses you teach and review your classes.',
};

function SignIn() {
  usePageTitle('Sign in');
  const { next, link, provider, refused } = Route.useSearch();
  const methods = Route.useLoaderData();
  const [entrance, setEntrance] = useState<Entrance>('student');
  const [email, setEmail] = useState('');
  // Survives request.reset(): once a link was requested the expired-link state is not shown again.
  const [requested, setRequested] = useState(false);
  const request = useMutation({
    mutationFn: (address: string) =>
      call(requestSignInLink, { body: { email: address, entrance, ...(next ? { next } : {}) } }),
  });
  // Only a configured provider is explained; a site without providers ignores the parameters.
  const refusedBy = refused && methods.providers.find((p) => p.id === provider)?.name;
  // A link, not a form: the start route redirects to the issuer, which `form-action 'self'` blocks.
  const startHref = (id: string) =>
    `/api/auth/oidc/${id}/start?${new URLSearchParams({ entrance, ...(next ? { next } : {}) })}`;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setRequested(true);
    request.mutate(email.trim());
  };

  return (
    <main id="main" className={styles.index}>
      <h1>Sign in</h1>
      {refusedBy && !requested ? (
        <div className={styles.feedback} role="alert">
          {refused === 'unverified' ? (
            <>
              <h2>{refusedBy} did not confirm an email address</h2>
              <p>
                Parallax signs you in to the account of a confirmed email address. {refusedBy} did
                not send one, so this sign-in was refused.
              </p>
              {methods.email ? <p>You can ask for an email link below.</p> : null}
            </>
          ) : (
            <>
              <h2>Signing in with {refusedBy} did not finish</h2>
              <p>Nothing was changed. Try again.</p>
            </>
          )}
        </div>
      ) : null}
      {methods.email && link === 'expired' && !requested ? (
        <div className={styles.feedback} role="alert">
          <h2>This sign-in link no longer works</h2>
          <p>Links work once and expire after 15 minutes. Request a new one below.</p>
        </div>
      ) : null}
      <div className={styles.editGrid}>
        <section
          aria-label={methods.providers.length > 0 ? 'Ways to sign in' : 'Sign in with email'}
        >
          <fieldset className={`${styles.row} ${styles.group}`} aria-label="Sign-in entrance">
            {(['student', 'instructor'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={buttons.outline}
                aria-pressed={entrance === value}
                onClick={() => setEntrance(value)}
              >
                {value === 'student' ? 'Student sign in' : 'Instructor sign in'}
              </button>
            ))}
          </fieldset>
          {!methods.email ? null : request.isSuccess ? (
            <div className={styles.feedback} role="status">
              <h2>Sign-in link requested</h2>
              <p>
                If {email.trim()} can sign in, a link is on its way. It works once and expires after
                15 minutes.
              </p>
              <p>
                <button
                  type="button"
                  className={buttons.textButton}
                  onClick={() => request.reset()}
                >
                  Use a different address
                </button>
              </p>
            </div>
          ) : (
            <form onSubmit={submit}>
              <label className={styles.field}>
                Email address
                <input
                  type="email"
                  name="email"
                  autoComplete="email"
                  required
                  placeholder="name@university.edu"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <div className={styles.mt20}>
                <button type="submit" className={buttons.primary} disabled={request.isPending}>
                  {request.isPending ? 'Sending…' : 'Send sign-in link'}
                </button>
              </div>
              {request.isError ? (
                <p role="alert" className={styles.mt16}>
                  The sign-in link could not be requested. Check the address and try again.
                </p>
              ) : null}
            </form>
          )}
          {methods.providers.length > 0 ? (
            <ul
              className={`${styles.bareListSpaced} ${styles.row}`}
              aria-label="Sign in with another account"
            >
              {methods.providers.map(({ id, name }) => (
                <li key={id}>
                  <a className={`${buttons.outline} ${styles.row}`} href={startHref(id)}>
                    Sign in with {name}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
        <aside className={styles.side}>
          <p className={`${styles.small} ${styles.muted}`}>
            {ABOUT[entrance]} Use the address on your invitation.
          </p>
        </aside>
      </div>
    </main>
  );
}

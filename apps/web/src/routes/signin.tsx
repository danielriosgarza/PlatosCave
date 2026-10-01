import { requestSignInLink } from '@parallax/contracts/routes/auth';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { call } from '../api/client';
import styles from '../components/Page.module.css';

type Entrance = 'student' | 'instructor';

interface SignInSearch {
  next?: string;
  link?: 'expired';
}

export const Route = createFileRoute('/signin')({
  validateSearch: (search: Record<string, unknown>): SignInSearch => ({
    next: typeof search.next === 'string' && search.next ? search.next : undefined,
    link: search.link === 'expired' ? 'expired' : undefined,
  }),
  component: SignIn,
});

const ABOUT: Record<Entrance, string> = {
  student: 'Open enrolled courses and resume your work.',
  instructor: 'Open courses you teach and review your classes.',
};

function SignIn() {
  const { next, link } = Route.useSearch();
  const [entrance, setEntrance] = useState<Entrance>('student');
  const [email, setEmail] = useState('');
  // Survives request.reset(): once a link was requested the expired-link state is not shown again.
  const [requested, setRequested] = useState(false);
  const request = useMutation({
    mutationFn: (address: string) =>
      call(requestSignInLink, { body: { email: address, entrance, ...(next ? { next } : {}) } }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setRequested(true);
    request.mutate(email.trim());
  };

  return (
    <main className={styles.index}>
      <h1>Sign in</h1>
      {link === 'expired' && !requested ? (
        <div className={styles.feedback} role="alert">
          <h2>This sign-in link no longer works</h2>
          <p>Links work once and expire after 15 minutes. Request a new one below.</p>
        </div>
      ) : null}
      <div className={styles.editGrid}>
        <section aria-label="Sign in with email">
          <fieldset className={`${styles.row} ${styles.group}`} aria-label="Sign-in entrance">
            {(['student', 'instructor'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={styles.outline}
                aria-pressed={entrance === value}
                onClick={() => setEntrance(value)}
              >
                {value === 'student' ? 'Student sign in' : 'Instructor sign in'}
              </button>
            ))}
          </fieldset>
          {request.isSuccess ? (
            <div className={styles.feedback} role="status">
              <h2>Sign-in link requested</h2>
              <p>
                If {email.trim()} can sign in, a link is on its way. It works once and expires after
                15 minutes.
              </p>
              <p>
                <button type="button" className={styles.textButton} onClick={() => request.reset()}>
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
              <div style={{ marginTop: 20 }}>
                <button type="submit" className={styles.primary} disabled={request.isPending}>
                  {request.isPending ? 'Sending…' : 'Send sign-in link'}
                </button>
              </div>
              {request.isError ? (
                <p role="alert" style={{ marginTop: 16 }}>
                  The sign-in link could not be requested. Check the address and try again.
                </p>
              ) : null}
            </form>
          )}
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

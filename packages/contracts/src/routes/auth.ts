import { z } from 'zod';
import { defineRoute } from '../define';

/** §3: one identity service behind both entrances; the entrance only picks the default page. */
export const requestSignInLink = defineRoute({
  method: 'POST',
  path: '/api/auth/link',
  scope: { kind: 'public' },
  status: 202,
  summary: 'Email a single-use sign-in link; always accepted, whether or not the account exists',
  body: z.object({
    email: z.email().max(254),
    /** Same-origin path to open after sign-in; anything else is ignored. */
    next: z.string().max(2048).optional(),
    entrance: z.enum(['student', 'instructor']).optional(),
  }),
  response: z.object({ accepted: z.literal(true) }),
  examples: { body: { email: 'sam@example.test', next: '/courses', entrance: 'student' } },
});

export const verifySignInLink = defineRoute({
  method: 'GET',
  path: '/api/auth/verify',
  scope: { kind: 'public' },
  status: 302,
  summary:
    'Use a sign-in link: starts a session and redirects to the preserved destination, or to /signin?link=expired',
  // Opened by a browser from an email: a mangled query must still land on the expired-link
  // page, never a JSON validation error, so anything but one string counts as no token.
  query: z.object({ token: z.string().optional().catch(undefined) }),
  response: z.null(),
  examples: { query: { token: 'example-token' } },
});

export const signOut = defineRoute({
  method: 'POST',
  path: '/api/auth/signout',
  scope: { kind: 'public' },
  summary: 'End the current session and clear its cookie',
  response: z.object({ signedOut: z.literal(true) }),
  examples: {},
});

import { z } from 'zod';
import { defineRoute, errorBody } from '../define';

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
  errors: { 429: errorBody },
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
  errors: { 429: errorBody },
  examples: { query: { token: 'example-token' } },
});

/** A configured provider's id, the path segment of its routes. */
export const providerId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const DISPLAY_NAME = /^\P{Cc}{1,60}$/u; // 1 to 60 characters, none a control character

/** An OpenID Connect issuer as the operator lists it: no secret, no look of its own (ADR-0002). */
export const providerSettings = z.strictObject({
  id: providerId,
  name: z.string().trim().regex(DISPLAY_NAME),
  // https, without credentials, query or fragment
  issuer: z.url({ protocol: /^https$/ }).regex(/^https:\/\/[^/?#@]+(\/[^?#]*)?$/),
  clientId: z.string().min(1).max(255),
});

/** The ways to sign in this server offers; never an issuer, a client id or a secret. */
export const signInMethods = z.object({
  email: z.boolean(),
  providers: z.array(z.object({ id: providerId, name: z.string() })),
});

export const listSignInMethods = defineRoute({
  method: 'GET',
  path: '/api/auth/methods',
  scope: { kind: 'public' },
  summary: 'Whether email links are offered, and the id and name of each configured provider',
  response: signInMethods,
  examples: {},
});

// Opened by a browser: a value that is not one string is absent, never a validation error.
const loose = z.string().optional().catch(undefined);
const entrance = z.enum(['student', 'instructor']).optional().catch(undefined);

export const startProviderSignIn = defineRoute({
  method: 'GET',
  path: '/api/auth/oidc/:provider/start',
  scope: { kind: 'public' },
  status: 302,
  summary: 'Start a sign-in with a configured provider: redirects to the issuer',
  params: z.object({ provider: z.string() }),
  query: z.object({ next: loose, entrance }),
  response: z.null(),
  errors: { 429: errorBody },
  examples: { params: { provider: 'university' }, query: { next: '/courses' } },
});

export const finishProviderSignIn = defineRoute({
  method: 'GET',
  path: '/api/auth/oidc/:provider/callback',
  scope: { kind: 'public' },
  status: 302,
  summary: 'Finish a provider sign-in: starts a session, or redirects to /signin with the reason',
  params: z.object({ provider: z.string() }),
  query: z.object({ code: loose, state: loose, iss: loose, error: loose }),
  response: z.null(),
  errors: { 429: errorBody },
  examples: { params: { provider: 'university' }, query: { code: 'example', state: 'example' } },
});

export const signOut = defineRoute({
  method: 'POST',
  path: '/api/auth/signout',
  scope: { kind: 'public' },
  summary: 'End the current session and clear its cookie',
  response: z.object({ signedOut: z.literal(true) }),
  examples: {},
});

import { z } from 'zod';
import { defineRoute } from '../define';

/*
 * End-to-end fixture routes (ADR-0006). The server mounts them only with TEST_ROUTES=1, which
 * the configuration refuses in production; otherwise they answer 404 like any unknown path.
 */

export const buildTestWorld = defineRoute({
  method: 'POST',
  path: '/api/test/world',
  scope: { kind: 'public' },
  summary: 'Test only: build the standard fixture world once and return its ids',
  response: z.object({ ids: z.record(z.string(), z.uuid()), created: z.boolean() }),
  examples: {},
});

export const signInAs = defineRoute({
  method: 'POST',
  path: '/api/test/signin-as',
  scope: { kind: 'public' },
  summary: 'Test only: start a session for an email address, creating the account if needed',
  body: z.object({
    email: z.email(),
    /** Backdates the authentication time, to exercise the recent sign-in rule (§3). */
    authenticatedMinutesAgo: z.number().int().min(0).max(1440).default(0),
  }),
  response: z.object({ userId: z.uuid() }),
  examples: { body: { email: 'sam@example.test' } },
});

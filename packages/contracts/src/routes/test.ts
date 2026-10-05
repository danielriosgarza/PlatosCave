import { z } from 'zod';
import { defineRoute } from '../define';
import { exampleIds } from '../examples';

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

const connectorParams = z.object({ connectorId: z.uuid() });
const exampleConnector = { connectorId: exampleIds.aa };

/**
 * Test only: approves one of the signed-in person's pending connectors through the same service
 * as the Approve button, without its recent sign-in check (docs/design/connector.md §15).
 */
export const approveConnectorForTest = defineRoute({
  method: 'POST',
  path: '/api/test/connectors/:connectorId/approve',
  scope: { kind: 'user' },
  summary: "Test only: approve one of the signed-in person's pending connectors",
  params: connectorParams,
  response: z.object({ status: z.literal('active') }),
  errors: { 409: z.object({ error: z.enum(['not_pending', 'too_many_connectors']) }) },
  examples: { params: exampleConnector },
});

/** Test only: closes the live link of one of the signed-in person's connectors (A31, A36). */
export const dropConnectorLink = defineRoute({
  method: 'POST',
  path: '/api/test/connectors/:connectorId/drop-link',
  scope: { kind: 'user' },
  summary: "Test only: close the live link of one of the signed-in person's connectors",
  params: connectorParams,
  response: z.object({ dropped: z.boolean() }),
  examples: { params: exampleConnector },
});

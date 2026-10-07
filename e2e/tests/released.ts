import { type APIRequestContext, expect, type PlaywrightWorkerArgs } from '@playwright/test';

type Playwright = PlaywrightWorkerArgs['playwright'];

export interface WorldIds {
  statistics: string;
  classA: string;
  sampling: string;
  [key: string]: string;
}

export async function signedIn(
  playwright: Playwright,
  baseURL: string | undefined,
  email: string,
): Promise<APIRequestContext> {
  const client = await playwright.request.newContext({ baseURL });
  expect((await client.post('/api/test/signin-as', { data: { email } })).ok()).toBe(true);
  return client;
}

/** Builds the standard world (once per run; later calls return the same ids). */
export async function worldIds(playwright: Playwright, baseURL: string | undefined) {
  const setup = await playwright.request.newContext({ baseURL });
  const response = await setup.post('/api/test/world');
  expect(response.ok()).toBe(true);
  const { ids } = (await response.json()) as { ids: WorldIds };
  await setup.dispose();
  return ids;
}

/**
 * Creates `content` as a new resource in Sampling and releases it to class A, the way an
 * instructor would. Other test files publish to the same class from other workers, and a release
 * built before this resource existed would remove it again, so the helper checks that the
 * student can open the resource and publishes and adopts again until it can.
 */
export async function releaseToClassA(
  playwright: Playwright,
  baseURL: string | undefined,
  ids: WorldIds,
  type: 'exercise' | 'test',
  title: string,
  content: object,
): Promise<string> {
  const elena = await signedIn(playwright, baseURL, 'elena@example.test');
  const priya = await signedIn(playwright, baseURL, 'priya@example.test');
  const sam = await signedIn(playwright, baseURL, 'sam@example.test');
  try {
    const created = await elena.post(
      `/api/courses/${ids.statistics}/topics/${ids.sampling}/resources`,
      { data: { type, title, content } },
    );
    expect(created.ok()).toBe(true);
    const resourceId = ((await created.json()) as { id: string }).id;
    const opens = `/api/classes/${ids.classA}/resources/${resourceId}/${type}`;
    for (let round = 0; round < 6; round++) {
      const published = await elena.post(`/api/courses/${ids.statistics}/releases`);
      expect(published.ok()).toBe(true);
      const { release } = (await published.json()) as { release: { id: string } };
      const current = (await (await priya.get(`/api/classes/${ids.classA}/release`)).json()) as {
        release: { id: string };
      };
      // A 409 means another file adopted in between: look again.
      await priya.post(`/api/classes/${ids.classA}/adopt`, {
        data: { releaseId: release.id, expectedReleaseId: current.release.id },
      });
      if ((await sam.get(opens)).ok()) return resourceId;
    }
    throw new Error(`${title} never became visible to class A`);
  } finally {
    await Promise.all([elena.dispose(), priya.dispose(), sam.dispose()]);
  }
}

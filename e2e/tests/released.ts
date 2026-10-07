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

export const exerciseDefinition = {
  schema: 'exercise.v1',
  steps: [
    {
      id: 'predict',
      kind: 'single_choice',
      title: 'Predict',
      prompt: 'What happens to the standard error when n goes from 25 to 100?',
      options: [
        { id: 'half', label: 'It halves' },
        { id: 'same', label: 'It stays the same' },
      ],
      correct: 'half',
      feedback: { correct: 'Yes, the standard error halves.', incorrect: 'Not quite.' },
    },
    {
      id: 'explain',
      kind: 'text',
      title: 'Explain',
      prompt: 'Which distribution narrowed, and which did not?',
      feedback: { saved: 'Saved. Your practice is complete.' },
    },
  ],
};

/** A choice, a written explanation and a code question (the runner is not attached in e2e). */
export const testDefinition = {
  schema: 'test.v1',
  settings: { attempts: 3, timeZone: 'Europe/Madrid' },
  questions: [
    {
      id: 'spread',
      kind: 'choice',
      prompt: 'Which sample mean varies least?',
      points: 2,
      options: [
        { id: 'n10', label: 'n = 10' },
        { id: 'n100', label: 'n = 100' },
      ],
      correct: ['n100'],
    },
    {
      id: 'why',
      kind: 'explanation',
      prompt: 'Why does the larger sample vary less?',
      points: 3,
      rubric: [{ id: 'averaging', label: 'Names averaging out of noise', points: 3 }],
    },
    {
      id: 'mean',
      kind: 'code',
      prompt: 'Write mean(xs).',
      points: 4,
      runtime: 'python-3.12',
      files: [
        {
          path: 'solution.py',
          content: 'def mean(xs):\n    pass\n',
          editable: true,
          hidden: false,
        },
      ],
      checks: [
        {
          name: 'sample',
          kind: 'call',
          visibility: 'public',
          file: 'solution.py',
          function: 'mean',
          args: [[1, 2, 3]],
          expected: { value: 2 },
          compare: { mode: 'numeric' },
        },
      ],
    },
  ],
};

export interface NewResource {
  type: 'exercise' | 'test';
  title: string;
  content: object;
}

/**
 * Creates the resources in Sampling and releases them to class A with one release, the way an
 * instructor would, and returns their ids in order. Other test files publish to the same class
 * from other workers, so the helper adopts only when its release is newer than the one in force
 * (an older adopt would remove another file's resource) and repeats until the student can open
 * every resource.
 */
export async function releaseToClassA(
  playwright: Playwright,
  baseURL: string | undefined,
  ids: WorldIds,
  resources: NewResource[],
): Promise<string[]> {
  const elena = await signedIn(playwright, baseURL, 'elena@example.test');
  const priya = await signedIn(playwright, baseURL, 'priya@example.test');
  const sam = await signedIn(playwright, baseURL, 'sam@example.test');
  try {
    const resourceIds: string[] = [];
    for (const { type, title, content } of resources) {
      const created = await elena.post(
        `/api/courses/${ids.statistics}/topics/${ids.sampling}/resources`,
        { data: { type, title, content } },
      );
      expect(created.ok()).toBe(true);
      resourceIds.push(((await created.json()) as { id: string }).id);
    }
    const visible = async () => {
      for (const [index, { type }] of resources.entries()) {
        const opens = `/api/classes/${ids.classA}/resources/${resourceIds[index]}/${type}`;
        if (!(await sam.get(opens)).ok()) return false;
      }
      return true;
    };
    for (let round = 0; round < 8; round++) {
      const published = await elena.post(`/api/courses/${ids.statistics}/releases`);
      expect(published.ok()).toBe(true);
      const { release } = (await published.json()) as { release: { id: string; version: number } };
      const current = (await (await priya.get(`/api/classes/${ids.classA}/release`)).json()) as {
        release: { id: string; version: number } | null;
      };
      if (!current.release || current.release.version < release.version) {
        const adopted = await priya.post(`/api/classes/${ids.classA}/adopt`, {
          data: { releaseId: release.id, expectedReleaseId: current.release?.id ?? null },
        });
        // 409: another file adopted between the read and the post; look again.
        expect([200, 201, 409], `adopt answered ${adopted.status()}`).toContain(adopted.status());
      }
      if (await visible()) return resourceIds;
    }
    throw new Error(`${resources.map((r) => r.title).join(', ')} never became visible to class A`);
  } finally {
    await Promise.all([elena.dispose(), priya.dispose(), sam.dispose()]);
  }
}

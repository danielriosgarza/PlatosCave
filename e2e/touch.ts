import { type APIRequestContext, expect, type Page } from '@playwright/test';

type Playwright = { request: { newContext(o: object): Promise<APIRequestContext> } };

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
        { id: 'same', label: 'It stays the same', feedback: 'The error depends on √n, not on n.' },
        { id: 'double', label: 'It doubles' },
      ],
      correct: 'half',
      hints: ['SE is proportional to 1 / √n.', 'Compare √25 with √100.'],
      solution: 'It halves: √100 is twice √25.',
      feedback: { correct: 'Yes, the standard error halves.', incorrect: 'Not quite.' },
    },
    {
      id: 'inspect',
      kind: 'simulation',
      title: 'Inspect',
      prompt: 'Compare n = 100 with the baseline n = 25.',
      control: { name: 'n', label: 'Sample size', min: 25, max: 200, step: 25, initial: 25 },
      observations: [{ id: 'se', label: 'Standard error' }],
      compare: [25, 100],
      feedback: { correct: 'Both sample sizes compared.', incomplete: 'Now compare with n = 100.' },
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

export async function signedIn(
  playwright: Playwright,
  baseURL: string,
  email: string,
): Promise<APIRequestContext> {
  const client = await playwright.request.newContext({ baseURL });
  expect((await client.post('/api/test/signin-as', { data: { email } })).ok()).toBe(true);
  return client;
}

/** Releases a fresh exercise in Sampling to class A, the way an instructor would. */
export async function releaseExercise(playwright: Playwright, baseURL: string, title: string) {
  const setup = await playwright.request.newContext({ baseURL });
  const { ids } = await (await setup.post('/api/test/world')).json();
  await setup.dispose();
  const elena = await signedIn(playwright, baseURL, 'elena@example.test');
  const created = await elena.post(
    `/api/courses/${ids.statistics}/topics/${ids.sampling}/resources`,
    { data: { type: 'exercise', title, content: exerciseDefinition } },
  );
  expect(created.ok()).toBe(true);
  const resource = await created.json();
  const published = await elena.post(`/api/courses/${ids.statistics}/releases`);
  expect(published.ok()).toBe(true);
  const { release } = await published.json();
  await elena.dispose();
  const priya = await signedIn(playwright, baseURL, 'priya@example.test');
  const current = await (await priya.get(`/api/classes/${ids.classA}/release`)).json();
  const adopted = await priya.post(`/api/classes/${ids.classA}/adopt`, {
    data: { releaseId: release.id, expectedReleaseId: current.release.id },
  });
  expect(adopted.ok()).toBe(true);
  return { ids, resourceId: resource.id as string, priya };
}

export async function openExercise(page: Page, classId: string, topicId: string, title: string) {
  await page.goto(`/classes/${classId}/topics/${topicId}/exercises`);
  const start = page
    .getByRole('listitem')
    .filter({ hasText: title })
    .getByRole('button', { name: 'Start' });
  const predict = page.getByRole('heading', { name: 'Predict' });
  await expect(start.or(predict)).toBeVisible();
  if (await start.isVisible()) await start.click();
  await expect(predict).toBeVisible();
}

/** Visible matches of `selector` whose box is under 44 px either way, named for the failure message. */
export const small = (page: Page, selector: string) =>
  page.locator(selector).evaluateAll((nodes) =>
    nodes
      .map((node) => {
        const box = node.getBoundingClientRect();
        const name =
          node.getAttribute('aria-label') ||
          node.textContent?.trim() ||
          node.getAttribute('name') ||
          node.tagName;
        return { name, box };
      })
      .filter(({ box }) => box.width > 0 && (box.height < 44 || box.width < 44))
      .map(({ name, box }) => `${name}: ${Math.round(box.width)}x${Math.round(box.height)}`),
  );

/** Releases a fresh two-question test in Sampling to class A; returns the ids and the title. */
export async function releaseTest(playwright: Playwright, baseURL: string, title: string) {
  const setup = await playwright.request.newContext({ baseURL });
  const { ids } = await (await setup.post('/api/test/world')).json();
  await setup.dispose();
  const elena = await signedIn(playwright, baseURL, 'elena@example.test');
  const definition = {
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
    ],
  };
  const created = await elena.post(
    `/api/courses/${ids.statistics}/topics/${ids.sampling}/resources`,
    { data: { type: 'test', title, content: definition } },
  );
  expect(created.ok()).toBe(true);
  const published = await elena.post(`/api/courses/${ids.statistics}/releases`);
  expect(published.ok()).toBe(true);
  const { release } = await published.json();
  await elena.dispose();
  const priya = await signedIn(playwright, baseURL, 'priya@example.test');
  const current = await (await priya.get(`/api/classes/${ids.classA}/release`)).json();
  const adopted = await priya.post(`/api/classes/${ids.classA}/adopt`, {
    data: { releaseId: release.id, expectedReleaseId: current.release.id },
  });
  expect(adopted.ok()).toBe(true);
  await priya.dispose();
  return { ids };
}

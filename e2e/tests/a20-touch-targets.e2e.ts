import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

test.use({ colorScheme: 'light', hasTouch: true, isMobile: true });

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const lab = { class: id(211), topic: id(311), nativeRevision: id(511), deckRevision: id(513) };
const topic = `/classes/${lab.class}/topics/${lab.topic}`;

const definition = {
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

async function signedIn(
  playwright: { request: { newContext(o: object): Promise<APIRequestContext> } },
  baseURL: string,
  email: string,
): Promise<APIRequestContext> {
  const client = await playwright.request.newContext({ baseURL });
  expect((await client.post('/api/test/signin-as', { data: { email } })).ok()).toBe(true);
  return client;
}

/** Releases a fresh exercise in Sampling to class A, the way an instructor would. */
async function releaseExercise(
  playwright: { request: { newContext(o: object): Promise<APIRequestContext> } },
  baseURL: string,
  title: string,
) {
  const setup = await playwright.request.newContext({ baseURL });
  const { ids } = await (await setup.post('/api/test/world')).json();
  await setup.dispose();
  const elena = await signedIn(playwright, baseURL, 'elena@example.test');
  const created = await elena.post(
    `/api/courses/${ids.statistics}/topics/${ids.sampling}/resources`,
    { data: { type: 'exercise', title, content: definition } },
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
  await priya.dispose();
  return { ids, resourceId: resource.id as string };
}

async function openExercise(page: Page, classId: string, topicId: string, title: string) {
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

test.beforeAll(async ({ playwright, baseURL }) => {
  const setup = await playwright.request.newContext({ baseURL });
  expect((await setup.post('/api/test/world')).ok()).toBe(true);
  await setup.dispose();
});

test.beforeEach(async ({ page }) => {
  const signedIn = await page.request.post('/api/test/signin-as', {
    data: { email: 'lab-reader@example.test' },
  });
  expect(signedIn.ok()).toBe(true);
});

/** Visible matches of `selector` whose box is under 44 px either way, named for the failure message. */
const small = (page: Page, selector: string) =>
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
      .filter(({ box }) => box.width > 0 && (box.height < 43.5 || box.width < 43.5))
      .map(({ name, box }) => `${name}: ${Math.round(box.width)}x${Math.round(box.height)}`),
  );

test('A20 the slide viewer toolbar, slide index and picker are at least 44 px with a touch screen', async ({
  page,
}) => {
  await page.goto(`${topic}/slides`);
  await expect(page.locator('[data-page]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Full screen' })).toBeVisible();
  expect(await small(page, 'main button, main select')).toEqual([]);
});

test('A20 the reading margin toolbar is at least 44 px with a touch screen', async ({ page }) => {
  await page.goto(`${topic}/reading?resource=${lab.nativeRevision}`);
  await expect(page.locator('[data-block-id]').first()).toBeVisible();
  await page.evaluate(() => {
    const block = document.querySelector('[data-block-id]');
    const text = block && document.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode();
    if (!text) throw new Error('no text to select');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  const tools = page.getByRole('toolbar', { name: 'Selected passage' });
  await expect(tools).toBeVisible();
  expect(await small(page, '[role="toolbar"] button, main select')).toEqual([]);
});

test('A20 the review panel checkboxes and the notebook toolbar are at least 44 px with a touch screen', async ({
  page,
}) => {
  await page.goto(`${topic}/reading?resource=${lab.nativeRevision}`);
  const boxes = page.getByRole('checkbox');
  await expect(boxes.first()).toBeVisible();
  const rows = await boxes.evaluateAll((nodes) =>
    nodes.map((node) => {
      const row = (node.closest('label') ?? node).getBoundingClientRect();
      return Math.round(row.height);
    }),
  );
  expect(rows.length).toBeGreaterThan(0);
  for (const height of rows) expect(height).toBeGreaterThanOrEqual(44);

  await page.goto(`${topic}/notebooks`);
  await expect(page.getByRole('button', { name: 'Full screen' })).toBeVisible();
  expect(await small(page, 'main button, main select')).toEqual([]);
});

test('A20 the exercise range control is at least 44 px tall with a touch screen', async ({
  page,
  playwright,
  baseURL,
}) => {
  const title = `Touch range ${Date.now()}-${test.info().workerIndex}`;
  const { ids } = await releaseExercise(playwright, baseURL ?? '', title);
  expect(
    (await page.request.post('/api/test/signin-as', { data: { email: 'sam@example.test' } })).ok(),
  ).toBe(true);
  await openExercise(page, ids.classA, ids.sampling, title);
  await page.getByRole('radio', { name: 'It halves' }).check();
  await page.getByRole('button', { name: 'Check answer' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  const slider = page.getByRole('slider', { name: /Sample size/ });
  await expect(slider).toBeVisible();
  const box = await slider.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5);
});

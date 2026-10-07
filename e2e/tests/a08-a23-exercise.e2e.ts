import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

test.use({ colorScheme: 'light' });

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
  const priya = await signedIn(playwright, baseURL, 'priya@example.test');
  const current = await (await priya.get(`/api/classes/${ids.classA}/release`)).json();
  const adopted = await priya.post(`/api/classes/${ids.classA}/adopt`, {
    data: { releaseId: release.id, expectedReleaseId: current.release.id },
  });
  expect(adopted.ok()).toBe(true);
  return { ids, resourceId: resource.id as string, priya };
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

test('A08 and A23 a student works Predict, Inspect and Explain; help is recorded and survives Start again', async ({
  page,
  playwright,
  baseURL,
}) => {
  const base = baseURL ?? '';
  const title = `Standard error ${Date.now()}-${test.info().workerIndex}`;
  const { ids, resourceId, priya } = await releaseExercise(playwright, base, title);
  expect(
    (await page.request.post('/api/test/signin-as', { data: { email: 'sam@example.test' } })).ok(),
  ).toBe(true);
  await openExercise(page, ids.classA, ids.sampling, title);

  // Predict: a wrong answer gets its specific feedback, keeps the choice, allows retry.
  await expect(page.getByRole('img', { name: /Exercise step 1 of 3: Predict/ })).toBeVisible();
  await page.getByRole('radio', { name: 'It stays the same' }).check();
  await page.getByRole('button', { name: 'Check answer' }).click();
  await expect(page.getByText('The error depends on √n, not on n.')).toBeVisible();
  await expect(page.getByRole('radio', { name: 'It stays the same' })).toBeChecked();

  // A hint is recorded; hiding it does not remove the record.
  await page.getByRole('button', { name: 'Show a hint' }).click();
  await expect(page.getByText('SE is proportional to 1 / √n.')).toBeVisible();
  await page.getByRole('button', { name: 'Hide hints' }).click();
  await expect(page.getByText('SE is proportional to 1 / √n.')).toHaveCount(0);
  await expect(page.getByText(/Hints used: 1 of 2/)).toBeVisible();

  await page.getByRole('radio', { name: 'It halves' }).check();
  await page.getByRole('button', { name: 'Check answer' }).click();
  await expect(page.getByText('Yes, the standard error halves.')).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  await page.getByRole('button', { name: 'Continue' }).click();

  // Inspect: the control works from the keyboard; only the compared values count.
  const slider = page.getByRole('slider', { name: /Sample size/ });
  await expect(slider).toHaveValue('25');
  await page.getByRole('button', { name: 'Record this value' }).click();
  await expect(page.getByText('Now compare with n = 100.')).toBeVisible();
  await slider.focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveValue('100');
  await page.getByRole('button', { name: 'Record this value' }).click();
  await expect(page.getByText('Both sample sizes compared.')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  // Explain: empty text cannot complete the exercise.
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('alert')).toHaveText('Write your explanation first.');
  await expect(page.getByRole('heading', { name: 'Exercise complete.' })).toHaveCount(0);
  await page.getByLabel('Your explanation').fill('The distribution of sample means narrowed.');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Saved. Your practice is complete.')).toBeVisible();
  await page.getByRole('button', { name: 'See summary' }).click();
  await expect(page.getByRole('heading', { name: 'Exercise complete.' })).toBeVisible();
  await expect(page.getByText(/Completed with hints\./)).toBeVisible();
  const how = page.getByRole('list', { name: 'How each step was completed' });
  await expect(how.getByRole('listitem').filter({ hasText: 'Predict' })).toContainText(
    'with hints',
  );
  await expect(how.getByRole('listitem').filter({ hasText: 'Inspect' })).toContainText(
    'independently',
  );

  // Start again begins a new attempt; the first attempt and its help record stay.
  await page.getByRole('button', { name: 'Start again' }).click();
  await expect(page.getByRole('heading', { name: 'Predict' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'It halves' })).not.toBeChecked();
  await expect(page.getByText(/Hints used/)).toHaveCount(0);
  const review = await (
    await priya.get(`/api/classes/${ids.classA}/resources/${resourceId}/exercise-attempts`)
  ).json();
  const [first, second] = review.attempts.sort(
    (a: { number: number }, b: { number: number }) => a.number - b.number,
  );
  expect(first).toMatchObject({ number: 1, restarted: true, completion: 'with_hints' });
  expect(first.steps[0]).toMatchObject({ help: 'with_hints', hintsShown: 1 });
  expect(first.steps[0].checks.map((c: { correct: boolean }) => c.correct)).toEqual([false, true]);
  expect(second).toMatchObject({ number: 2, completion: null });

  // The instructor sees the same facts rendered in the student's work, hints and solution
  // use as separate labelled lines, and the attempt that was started again.
  expect(
    (
      await page.request.post('/api/test/signin-as', { data: { email: 'priya@example.test' } })
    ).ok(),
  ).toBe(true);
  await page.goto(`/classes/${ids.classA}/review?selected=${first.student.id}&tab=exercises`);
  const region = page.getByRole('region', { name: `Exercise · ${title}` });
  await expect(region.getByText('Attempt 1')).toBeVisible();
  await expect(region).toContainText('Completed with hints');
  await expect(region).toContainText('started again afterwards');
  const predict = region.getByRole('list', { name: 'Attempt 1 Predict evidence' });
  await expect(predict).toContainText('Final answer: half');
  await expect(predict).toContainText('Checks made: 2');
  await expect(predict).toContainText('Hints shown: 1');
  await expect(predict).toContainText('Solution shown: No');
  await expect(region.getByRole('list', { name: 'Attempt 1 Inspect evidence' })).toContainText(
    'Hints shown: 0',
  );
  await expect(region.getByText('Attempt 2')).toBeVisible();
});

test('a scheduled exercise shows its release date to students instead of opening', async ({
  page,
  playwright,
  baseURL,
}) => {
  const base = baseURL ?? '';
  const title = `Scheduled ${Date.now()}-${test.info().workerIndex}`;
  const setup = await playwright.request.newContext({ baseURL: base });
  const { ids } = await (await setup.post('/api/test/world')).json();
  const elena = await signedIn(playwright, base, 'elena@example.test');
  const created = await elena.post(
    `/api/courses/${ids.statistics}/topics/${ids.sampling}/resources`,
    {
      data: { type: 'exercise', title, content: definition, releaseAt: '2099-01-15T09:00:00Z' },
    },
  );
  expect(created.ok()).toBe(true);
  const published = await elena.post(`/api/courses/${ids.statistics}/releases`);
  const { release } = await published.json();
  const priya = await signedIn(playwright, base, 'priya@example.test');
  const current = await (await priya.get(`/api/classes/${ids.classA}/release`)).json();
  expect(
    (
      await priya.post(`/api/classes/${ids.classA}/adopt`, {
        data: { releaseId: release.id, expectedReleaseId: current.release.id },
      })
    ).ok(),
  ).toBe(true);

  expect(
    (await page.request.post('/api/test/signin-as', { data: { email: 'sam@example.test' } })).ok(),
  ).toBe(true);
  await page.goto(`/classes/${ids.classA}/topics/${ids.sampling}/exercises`);
  const row = page.getByRole('listitem').filter({ hasText: title });
  await expect(row).toContainText(/Opens 15 Jan 2099/);
  await expect(row.getByRole('button', { name: 'Start' })).toHaveCount(0);
});

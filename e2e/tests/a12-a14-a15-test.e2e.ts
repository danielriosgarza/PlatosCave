import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

test.use({ colorScheme: 'light' });

const HIDDEN_CHECK = 'hidden-large-input';
const HIDDEN_FILE_TEXT = 'secret-hidden-fixture-40-44';

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
        { path: 'large.txt', content: HIDDEN_FILE_TEXT, editable: false, hidden: true },
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
        {
          name: HIDDEN_CHECK,
          kind: 'call',
          visibility: 'hidden',
          file: 'solution.py',
          files: ['large.txt'],
          function: 'mean',
          args: [[40, 44]],
          expected: { value: 42 },
          compare: { mode: 'numeric' },
          points: 3,
        },
      ],
    },
  ],
};

type Playwright = { request: { newContext(o: object): Promise<APIRequestContext> } };

async function signedIn(playwright: Playwright, baseURL: string, email: string) {
  const client = await playwright.request.newContext({ baseURL });
  expect((await client.post('/api/test/signin-as', { data: { email } })).ok()).toBe(true);
  return client;
}

/** Releases a fresh test in Sampling to class A, the way an instructor would. */
async function releaseTest(playwright: Playwright, baseURL: string, title: string) {
  const setup = await playwright.request.newContext({ baseURL });
  const { ids } = await (await setup.post('/api/test/world')).json();
  const elena = await signedIn(playwright, baseURL, 'elena@example.test');
  const created = await elena.post(
    `/api/courses/${ids.statistics}/topics/${ids.sampling}/resources`,
    { data: { type: 'test', title, content: definition } },
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

async function signInStudent(page: Page) {
  expect(
    (await page.request.post('/api/test/signin-as', { data: { email: 'sam@example.test' } })).ok(),
  ).toBe(true);
}

async function startAttempt(page: Page, classId: string, topicId: string, title: string) {
  await page.goto(`/classes/${classId}/topics/${topicId}/tests`);
  // The topic lists every released test; one test alone opens at once.
  const listed = page
    .getByRole('listitem')
    .filter({ hasText: title })
    .getByRole('button', { name: 'Open' });
  const heading = page.getByRole('heading', { name: title });
  await expect(listed.or(heading)).toBeVisible();
  if (await listed.isVisible()) await listed.click();
  await expect(heading).toBeVisible();
  await page.getByRole('button', { name: /^Start attempt|^Resume attempt/ }).click();
  await expect(page.getByRole('heading', { name: 'Question 1' })).toBeVisible();
}

test('A12 hidden checks and files never reach the browser; a sample run shows its queue state', async ({
  page,
  playwright,
  baseURL,
}) => {
  const title = `Sampling test ${Date.now()}-${test.info().workerIndex}-a12`;
  const { ids } = await releaseTest(playwright, baseURL ?? '', title);
  await signInStudent(page);
  const bodies: string[] = [];
  page.on('response', async (response) => {
    if (response.url().includes('/api/')) bodies.push(await response.text().catch(() => ''));
  });
  await startAttempt(page, ids.classA, ids.sampling, title);
  await page.getByRole('button', { name: /^Question 3/ }).click();
  await expect(page.getByText('Sample tests are shown.')).toBeVisible();
  await page.getByRole('button', { name: 'Run sample tests' }).click();
  // No runner is attached to the end-to-end server: the run is queued or reported unavailable,
  // and the page says which instead of leaving the output blank.
  await expect(page.getByRole('region', { name: 'Sample tests' })).toContainText(
    /Queued|Running|Run unavailable/,
  );
  const text = bodies.join('\n');
  expect(text).toContain('solution.py');
  expect(text).not.toContain(HIDDEN_CHECK);
  expect(text).not.toContain(HIDDEN_FILE_TEXT);
  expect(text).not.toContain('large.txt');
});

test('A14 and A20 a student answers, reviews and submits once; the receipt survives a reload', async ({
  page,
  playwright,
  baseURL,
}) => {
  const title = `Sampling test ${Date.now()}-${test.info().workerIndex}-a14`;
  const { ids, resourceId } = await releaseTest(playwright, baseURL ?? '', title);
  await signInStudent(page);
  await startAttempt(page, ids.classA, ids.sampling, title);
  // The terms stay in the prompt column.
  await expect(page.getByRole('region', { name: 'Assignment terms' })).toContainText(
    'Attempt 1 of 3',
  );

  await page.getByRole('radio', { name: 'n = 100' }).check();
  await expect(page.getByText(/^Saved \d/)).toBeVisible();
  await page.getByRole('checkbox', { name: 'Flag for review' }).check();
  await expect(
    page.getByRole('navigation', { name: 'Questions' }).getByText('Answered · Flagged'),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // The code editor is reachable from the keyboard and the screen-reader mode is a plain text area.
  await page.getByRole('button', { name: /^Question 3/ }).click();
  await expect(
    page.getByRole('textbox', { name: 'solution.py, your implementation' }),
  ).toBeVisible();
  await page.getByRole('button', { name: /Screen-reader mode/ }).click();
  await expect(
    page.getByRole('textbox', { name: 'solution.py, your implementation' }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole('button', { name: 'Review submission' }).click();
  await expect(page.getByRole('heading', { name: 'Review submission' })).toBeFocused();
  await expect(page.getByText('2 of 3 questions have no answer:')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  const submits: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/submit')) submits.push(request.postData() ?? '');
  });
  await page.getByRole('button', { name: 'Submit test' }).dblclick();
  await expect(page.getByRole('heading', { name: 'Test submitted' })).toBeVisible();
  const receipt = await page
    .locator('dd', { hasText: /^[0-9a-f-]{36}$/ })
    .first()
    .innerText();
  expect(
    new Set(submits.map((body) => (JSON.parse(body) as { submissionKey: string }).submissionKey))
      .size,
  ).toBe(1);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // One immutable submission: the server lists one attempt with this receipt, also after a reload.
  const student = page.request;
  const overview = await (
    await student.get(`/api/classes/${ids.classA}/resources/${resourceId}/test`)
  ).json();
  expect(overview.attempts).toHaveLength(1);
  expect(overview.attempts[0].receipt.submissionId).toBe(receipt);
  await page.reload();
  const listed = page
    .getByRole('listitem')
    .filter({ hasText: title })
    .getByRole('button', { name: 'Open' });
  await listed.click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Your attempts' })).toContainText(
    `Receipt ${receipt.slice(0, 8)}`,
  );
});

test('A15 a timed attempt expires offline: the receipt says what the server received and the local copy is kept', async ({
  page,
  context,
  playwright,
  baseURL,
}) => {
  const title = `Sampling test ${Date.now()}-${test.info().workerIndex}-a15`;
  const { ids, resourceId, priya } = await releaseTest(playwright, baseURL ?? '', title);
  // The class closes the test a few seconds from now: the deadline the server enforces.
  const closesAt = new Date(Date.now() + 12_000).toISOString();
  const terms = await priya.put(`/api/classes/${ids.classA}/resources/${resourceId}/assignment`, {
    data: { settings: { closesAt }, expectedRevision: null },
  });
  expect(terms.ok()).toBe(true);
  await signInStudent(page);
  await startAttempt(page, ids.classA, ids.sampling, title);

  await page.getByRole('radio', { name: 'n = 100' }).check();
  await expect(page.getByText(/^Saved \d/)).toBeVisible();

  await context.setOffline(true);
  await page.getByRole('button', { name: /^Question 2/ }).click();
  const text = `Averaging cancels noise ${Date.now()}`;
  await page.getByRole('textbox', { name: 'Your explanation' }).fill(text);
  await expect(page.getByText(/Not saved/)).toBeVisible();
  await page.waitForTimeout(Math.max(0, Date.parse(closesAt) - Date.now()) + 2500);
  // Offline, the page cannot claim anything about the server.
  await expect(page.getByRole('heading', { name: /Time ran out/ })).toHaveCount(0);
  await context.setOffline(false);

  await expect(page.getByRole('heading', { name: /Time ran out/ })).toBeVisible();
  await expect(page.getByText(/It received 1 answer/)).toBeVisible();
  await expect(page.getByText('Submitted by the server at the deadline')).toBeVisible();
  await expect(page.getByText(/Unsent changes are not part of this submission/)).toBeVisible();
  await expect(page.getByText(/were kept for your instructor/)).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // The instructor can recover the text; the submission itself holds only the saved answer.
  const attemptId = (
    await (await page.request.get(`/api/classes/${ids.classA}/resources/${resourceId}/test`)).json()
  ).attempts[0].id as string;
  const review = await (
    await priya.get(`/api/classes/${ids.classA}/test-attempts/${attemptId}/review`)
  ).json();
  expect(review.localCopy).toEqual([{ questionId: 'why', value: text }]);
  expect(review.answers.map((a: { questionId: string }) => a.questionId)).toEqual(['spread']);
});

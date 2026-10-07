import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { small } from '../touch';

test.use({ colorScheme: 'light', viewport: { width: 1440, height: 900 } });

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

type Playwright = { request: { newContext(o: object): Promise<APIRequestContext> } };

async function signedIn(playwright: Playwright, baseURL: string, email: string) {
  const client = await playwright.request.newContext({ baseURL });
  expect((await client.post('/api/test/signin-as', { data: { email } })).ok()).toBe(true);
  return client;
}

/**
 * A fresh test of the course released to class B (Marcus teaches Bea and Priya), with both
 * students having submitted it the way they would: answers saved, then Submit test.
 */
async function submittedTest(playwright: Playwright, baseURL: string, title: string) {
  const setup = await playwright.request.newContext({ baseURL });
  const { ids } = await (await setup.post('/api/test/world')).json();
  const elena = await signedIn(playwright, baseURL, 'elena@example.test');
  const created = await elena.post(
    `/api/courses/${ids.statistics}/topics/${ids.sampling}/resources`,
    { data: { type: 'test', title, content: definition } },
  );
  expect(created.ok()).toBe(true);
  const resourceId = (await created.json()).id as string;
  const published = await elena.post(`/api/courses/${ids.statistics}/releases`);
  expect(published.ok()).toBe(true);
  const { release } = await published.json();
  const marcus = await signedIn(playwright, baseURL, 'marcus@example.test');
  const current = await (await marcus.get(`/api/classes/${ids.classB}/release`)).json();
  const adopted = await marcus.post(`/api/classes/${ids.classB}/adopt`, {
    data: { releaseId: release.id, expectedReleaseId: current.release.id },
  });
  expect(adopted.ok()).toBe(true);

  const attempts: Record<string, string> = {};
  for (const who of ['bea', 'priya']) {
    const student = await signedIn(playwright, baseURL, `${who}@example.test`);
    const started = await student.post(
      `/api/classes/${ids.classB}/resources/${resourceId}/test-attempts`,
    );
    expect(started.ok()).toBe(true);
    const attemptId = (await started.json()).id as string;
    attempts[who] = attemptId;
    const url = `/api/classes/${ids.classB}/test-attempts/${attemptId}`;
    expect(
      (await student.put(`${url}/answers/spread`, { data: { value: ['n100'], seq: 1 } })).ok(),
    ).toBe(true);
    expect(
      (
        await student.put(`${url}/answers/why`, {
          data: { value: `Noise averages out for ${who}.`, seq: 1 },
        })
      ).ok(),
    ).toBe(true);
    expect(
      (
        await student.post(`${url}/submit`, {
          data: { submissionKey: `submit-${who}-${Date.now()}` },
        })
      ).ok(),
    ).toBe(true);
  }
  return { ids, resourceId, attempts };
}

async function signInInstructor(page: Page, email: string) {
  expect((await page.request.post('/api/test/signin-as', { data: { email } })).ok()).toBe(true);
}

/** Marks the explanation, saves the draft, and returns once the server acknowledged it. */
async function saveDraft(page: Page) {
  await page.getByLabel(/Names averaging out of noise/).fill('3');
  await page.getByRole('button', { name: 'Save draft grade' }).click();
  await expect(page.getByText(/Draft saved\. The student cannot see it/)).toBeVisible();
}

async function results(
  student: APIRequestContext,
  classId: string,
  resourceId: string,
): Promise<{ attempts: { status: string; grade: { points: number; possible: number } | null }[] }> {
  return (await student.get(`/api/classes/${classId}/resources/${resourceId}/results`)).json();
}

test('A17 a draft grade is invisible to the student until Release feedback; releasing makes exactly that result visible with actor and time', async ({
  page,
  playwright,
  baseURL,
}) => {
  const title = `Grading test ${Date.now()}-${test.info().workerIndex}-a17`;
  const { ids, resourceId, attempts } = await submittedTest(playwright, baseURL ?? '', title);
  const bea = await signedIn(playwright, baseURL ?? '', 'bea@example.test');
  await signInInstructor(page, 'marcus@example.test');

  await page.goto(
    `/classes/${ids.classB}/review?assignment=${resourceId}&selected=${ids.bea}&attempt=${attempts.bea}`,
  );
  const workspace = page.getByRole('region', { name: 'Grading workspace' });
  await expect(workspace).toContainText('Autumn 2026 B');
  await expect(workspace.getByText('Noise averages out for bea.')).toBeVisible();
  await expect(workspace.getByText('Chosen: n = 100')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Release feedback' })).toBeDisabled();

  await saveDraft(page);
  // The draft is saved, and the student reads nothing of it.
  const draftView = await results(bea, ids.classB, resourceId);
  expect(draftView.attempts).toHaveLength(1);
  expect(draftView.attempts[0]).toMatchObject({ status: 'pending', grade: null });

  await page.getByRole('button', { name: 'Release feedback' }).click();
  const preview = page.getByRole('region', { name: 'Release preview' });
  await expect(preview).toContainText('Release to Bea Lindqvist');
  await expect(preview).toContainText(`${title} · Attempt 1`);
  // Previewing released nothing.
  expect((await results(bea, ids.classB, resourceId)).attempts[0]).toMatchObject({
    status: 'pending',
  });
  await preview.getByRole('button', { name: 'Confirm release to 1 student' }).click();
  await expect(page.getByText(/Released to Bea Lindqvist on/)).toBeVisible();

  const released = await results(bea, ids.classB, resourceId);
  expect(released.attempts[0]).toMatchObject({
    status: 'released',
    grade: { points: 5, possible: 5 },
  });
  // The other student's result stays unreleased.
  const priya = await signedIn(playwright, baseURL ?? '', 'priya@example.test');
  expect((await results(priya, ids.classB, resourceId)).attempts[0]).toMatchObject({
    status: 'pending',
    grade: null,
  });
  // Actor and time are recorded on the release.
  const marcus = await signedIn(playwright, baseURL ?? '', 'marcus@example.test');
  const history = await (
    await marcus.get(`/api/classes/${ids.classB}/test-attempts/${attempts.bea}/grade`)
  ).json();
  expect(history.released).toMatchObject({ state: 'released' });
  expect(history.released.releasedAt).toBeTruthy();
  expect(history.released.releaseId).toBeTruthy();
});

test('A25 with Needs review active previous/next stays in that filter, and releasing the last result shows the empty state while keeping every released grade', async ({
  page,
  playwright,
  baseURL,
}) => {
  const title = `Grading test ${Date.now()}-${test.info().workerIndex}-a25`;
  const { ids, resourceId } = await submittedTest(playwright, baseURL ?? '', title);
  await signInInstructor(page, 'marcus@example.test');
  await page.goto(`/classes/${ids.classB}/review?assignment=${resourceId}&needsReview=true`);
  const table = page.getByRole('table');
  await expect(table.getByRole('button', { name: 'Bea Lindqvist' })).toBeVisible();
  await expect(table.getByRole('button', { name: 'Priya Nair' })).toBeVisible();

  await table.getByRole('button', { name: 'Bea Lindqvist' }).click();
  const selection = page.getByRole('region', { name: 'Selected student' });
  await expect(selection.getByRole('heading', { name: 'Bea Lindqvist' })).toBeVisible();
  await expect(selection).toContainText(`Test · ${title} · Attempt 1 · Student 1 of 2`);
  await selection.getByRole('button', { name: 'Next student' }).click();
  await expect(selection.getByRole('heading', { name: 'Priya Nair' })).toBeVisible();
  await expect(selection).toContainText('Student 2 of 2');
  await expect(selection.getByRole('button', { name: 'Next student' })).toBeDisabled();

  // Release Priya: the filtered list now holds Bea only; Priya's outcome stays on screen.
  await page.getByRole('tab', { name: 'Results' }).click();
  await saveDraft(page);
  await page.getByRole('button', { name: 'Release feedback' }).click();
  await page
    .getByRole('region', { name: 'Release preview' })
    .getByRole('button', { name: 'Confirm release to 1 student' })
    .click();
  await expect(page.getByText(/Released to Priya Nair on/)).toBeVisible();
  await expect(table.getByRole('button', { name: 'Bea Lindqvist' })).toBeVisible();
  await expect(table.getByRole('button', { name: 'Priya Nair' })).toHaveCount(0);

  // Release the last one: the empty state offers every student again.
  await table.getByRole('button', { name: 'Bea Lindqvist' }).click();
  await saveDraft(page);
  await page.getByRole('button', { name: 'Release feedback' }).click();
  await page
    .getByRole('region', { name: 'Release preview' })
    .getByRole('button', { name: 'Confirm release to 1 student' })
    .click();
  await expect(page.getByRole('heading', { name: 'No students need review.' })).toBeVisible();
  await page.getByRole('button', { name: 'Show all students' }).click();
  const all = page.getByRole('table');
  for (const name of ['Bea Lindqvist', 'Priya Nair']) {
    const row = all.getByRole('button', { name }).locator('xpath=ancestor::tr');
    await expect(row).toContainText('Released · 5 / 5 released');
    await expect(row).toContainText('Reviewed');
  }
});

const notebookFile = {
  cells: [],
  metadata: {
    kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
    language_info: { name: 'python', version: '3.12.1' },
  },
  nbformat: 4,
  nbformat_minor: 5,
};

test('A35 an instructor inspects a submitted notebook snapshot in Parallax without any request to a connector', async ({
  page,
  playwright,
  baseURL,
}) => {
  const setup = await playwright.request.newContext({ baseURL });
  expect((await setup.post('/api/test/world')).ok()).toBe(true);
  const lab = {
    classId: '00000000-0000-4000-8000-000000000211',
    reader: '00000000-0000-4000-8000-000000000022',
    notebook: '00000000-0000-4000-8000-000000000414',
  };
  const rui = await signedIn(playwright, baseURL ?? '', 'lab-reader@example.test');
  const sent = await rui.post(
    `/api/classes/${lab.classId}/resources/${lab.notebook}/notebook-submissions?submissionKey=a35-${Date.now()}-${test.info().workerIndex}`,
    {
      multipart: {
        file: {
          name: 'lab.ipynb',
          mimeType: 'application/x-ipynb+json',
          buffer: Buffer.from(JSON.stringify(notebookFile)),
        },
      },
    },
  );
  expect(sent.ok()).toBe(true);

  await signInInstructor(page, 'lab-instructor@example.test');
  const requests: string[] = [];
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  await page.goto(`/classes/${lab.classId}/review?selected=${lab.reader}&tab=submissions`);
  await expect(page.getByRole('heading', { name: 'Rui Alves' })).toBeVisible();
  const snapshot = page.getByRole('region', { name: /^Notebook · / });
  await expect(snapshot).toContainText('lab.ipynb');
  await expect(snapshot).toContainText('Declared by the file, not verified');
  const link = page.waitForResponse((res) => res.url().includes('/notebook-submissions/'));
  await snapshot.getByRole('button', { name: 'Download snapshot' }).first().click();
  expect((await link).ok()).toBe(true);
  // Nothing was asked of any computer: no connector, connection or session route was touched.
  expect(requests.filter((p) => /connector|connection|notebook-sessions/.test(p))).toEqual([]);
  await expect(page.getByRole('button', { name: /connect/i })).toHaveCount(0);
});

test.describe('coarse pointer', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('A20 the class review filters, release tick and table buttons are at least 44 px with a touch screen', async ({
    page,
    playwright,
    baseURL,
  }) => {
    const title = `Grading test ${Date.now()}-${test.info().workerIndex}-a20`;
    const { ids, resourceId, attempts } = await submittedTest(playwright, baseURL ?? '', title);
    await signInInstructor(page, 'marcus@example.test');
    await page.goto(
      `/classes/${ids.classB}/review?assignment=${resourceId}&selected=${ids.bea}&attempt=${attempts.bea}`,
    );
    await saveDraft(page);
    await page.goto(`/classes/${ids.classB}/review?assignment=${resourceId}`);
    const tick = page.getByRole('checkbox', { name: 'Select Bea Lindqvist for release' });
    await expect(tick).toBeVisible();
    const row = await tick.evaluate((node) => {
      const box = (node.closest('label') ?? node).getBoundingClientRect();
      return { width: box.width, height: box.height };
    });
    expect(row.width).toBeGreaterThanOrEqual(43.5);
    expect(row.height).toBeGreaterThanOrEqual(43.5);
    expect(
      await small(page, 'main button, main select, main input:not([type="checkbox"])'),
    ).toEqual([]);
  });
});

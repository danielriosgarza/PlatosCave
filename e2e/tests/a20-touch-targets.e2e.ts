import { expect, test } from '@playwright/test';
import { openExercise, releaseExercise, releaseTest, small } from '../touch';
import { signedIn } from './released';

test.use({ colorScheme: 'light', hasTouch: true, isMobile: true });

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const lab = { class: id(211), topic: id(311), nativeRevision: id(511), deckRevision: id(513) };
const topic = `/classes/${lab.class}/topics/${lab.topic}`;

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
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
});

for (const email of ['marcus@example.test', 'priya@example.test']) {
  test(`A20 the courses filters, status and view links of ${email} are at least 44 px with a touch screen`, async ({
    page,
  }) => {
    expect((await page.request.post('/api/test/signin-as', { data: { email } })).ok()).toBe(true);
    await page.goto('/courses');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Filter courses' })).toBeVisible();
    expect(await small(page, 'main button, main a, main select, main input')).toEqual([]);
  });
}

test('A20 the class chooser links and the join notice link are at least 44 px with a touch screen', async ({
  page,
  playwright,
  baseURL,
}) => {
  const { ids } = await (await page.request.post('/api/test/world')).json();
  const owner = await signedIn(playwright, baseURL ?? '', 'elena@example.test');
  const issued = async (classId: string) => {
    const res = await owner.post(`/api/classes/${classId}/invites`, {
      data: { kind: 'enrolment', maxUses: 1 },
    });
    expect(res.ok()).toBe(true);
    return (await res.json()).code as string;
  };
  const codeA = await issued(ids.classA);
  const codeB = await issued(ids.classB);
  await owner.dispose();

  const email = `a20-chooser-${Date.now()}@example.test`;
  expect((await page.request.post('/api/test/signin-as', { data: { email } })).ok()).toBe(true);
  await page.goto('/courses');
  await page.getByLabel('Invitation code').fill(codeA);
  await page.getByRole('button', { name: 'Join class' }).click();
  await expect(page.getByRole('status')).toContainText('You joined');
  expect(await small(page, 'main [role="status"] a')).toEqual([]);

  expect((await page.request.post('/api/join', { data: { code: codeB } })).ok()).toBe(true);
  await page.goto('/courses');
  await page.getByRole('button', { name: 'Choose class' }).click();
  await expect(page.getByRole('list', { name: /^Classes of / })).toBeVisible();
  expect(await small(page, 'main button, main a, main select, main input')).toEqual([]);
});

test('A20 the topic index title and Start or Resume links are at least 44 px with a touch screen', async ({
  page,
}) => {
  await page.goto(`/classes/${lab.class}/topics`);
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.locator('main table a').first()).toBeVisible();
  expect(await small(page, 'main table a')).toEqual([]);
});

test('A12 and A14 the test question navigation is at least 44 px with a touch screen', async ({
  page,
  playwright,
  baseURL,
}) => {
  const title = `Touch test ${Date.now()}-${test.info().workerIndex}`;
  const { ids } = await releaseTest(playwright, baseURL ?? '', title);
  expect(
    (await page.request.post('/api/test/signin-as', { data: { email: 'sam@example.test' } })).ok(),
  ).toBe(true);
  await page.goto(`/classes/${ids.classA}/topics/${ids.sampling}/tests`);
  const open = page
    .getByRole('listitem')
    .filter({ hasText: title })
    .getByRole('button', { name: 'Open' });
  const heading = page.getByRole('heading', { name: title });
  await expect(open.or(heading)).toBeVisible();
  if (await open.isVisible()) await open.click();
  await expect(heading).toBeVisible();
  await page.getByRole('button', { name: /^Start attempt|^Resume attempt/ }).click();
  const nav = page.getByRole('navigation', { name: 'Questions' });
  await expect(nav.getByRole('button', { name: /^Question 2/ })).toBeVisible();
  expect(await small(page, '[aria-label="Questions"] button')).toEqual([]);
});

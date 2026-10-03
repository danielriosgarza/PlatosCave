import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, request, test } from '@playwright/test';

test.use({ colorScheme: 'light' });

/**
 * Signs `page` in through the fixture route. No mail is involved, so these tests cannot take
 * another spec's sign-in link for the same address when files run in parallel.
 */
async function signIn(page: Page, baseURL: string | undefined, email: string) {
  const client = await request.newContext({ baseURL });
  try {
    expect((await client.post('/api/test/signin-as', { data: { email } })).ok()).toBe(true);
    await page.context().addCookies((await client.storageState()).cookies);
  } finally {
    await client.dispose();
  }
}

const SECRET_TITLE = 'Unreleased Bayesian methods';

// The draft lives in a course no class has adopted, so other specs' topic counts are untouched.
test('A01 a link to an unpublished topic shows the neutral page and discloses nothing', async ({
  page,
  playwright,
  baseURL,
}) => {
  const owner = await playwright.request.newContext({ baseURL });
  const world = await (await owner.post('/api/test/world')).json();
  expect(
    (await owner.post('/api/test/signin-as', { data: { email: 'olivia@example.test' } })).ok(),
  ).toBe(true);
  const draft = await owner.post(`/api/courses/${world.ids.linearModels}/topics`, {
    data: { title: SECRET_TITLE, objective: 'Not yet published to any class.' },
  });
  expect(draft.ok()).toBe(true);
  const { id } = await draft.json();
  await owner.dispose();

  await signIn(page, baseURL, 'sam@example.test');
  const bodies: Promise<string>[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/api/')) bodies.push(response.text().catch(() => ''));
  });
  await page.goto(`/classes/${world.ids.classA}/topics/${id}/reading`);
  await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
  // The server denies it too: no API answer the page received carries the draft's title.
  const received = await Promise.all(bodies);
  expect(received.length).toBeGreaterThan(0);
  expect(received.some((b) => b.includes(SECRET_TITLE))).toBe(false);
  const text = await page.locator('body').innerText();
  expect(text).not.toContain(SECRET_TITLE);
  expect(text).not.toContain('Statistical thinking');
  expect(text).not.toContain('Not yet published');
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations).toEqual([]);
});

test('A01 a link into another class shows the same neutral page as an unpublished topic', async ({
  page,
  playwright,
  baseURL,
}) => {
  const setup = await playwright.request.newContext({ baseURL });
  const world = await (await setup.post('/api/test/world')).json();
  await setup.dispose();
  await signIn(page, baseURL, 'bea@example.test');
  await page.goto(`/classes/${world.ids.classA}/topics/${world.ids.sampling}/reading`);
  await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
  const text = await page.locator('body').innerText();
  expect(text).not.toContain('Sampling');
  expect(text).not.toContain('Autumn 2026 A');
});

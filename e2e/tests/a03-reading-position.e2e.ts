import { expect, type Page, test } from '@playwright/test';

test.use({ colorScheme: 'light' });

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const lab = { class: id(211), topic: id(311), native: id(511), pdf: id(512) };
const reading = `/classes/${lab.class}/topics/${lab.topic}/reading`;

test.beforeAll(async ({ playwright, baseURL }) => {
  const setup = await playwright.request.newContext({ baseURL });
  expect((await setup.post('/api/test/world')).ok()).toBe(true);
});

test.beforeEach(async ({ page }) => {
  const signedIn = await page.request.post('/api/test/signin-as', {
    data: { email: 'lab-reader@example.test' },
  });
  expect(signedIn.ok()).toBe(true);
});

const scrollTop = (page: Page) => page.evaluate(() => Math.round(window.scrollY));
/** Waits for the debounced position save to reach the server (§8: the pause before a save). */
const savedPosition = (page: Page) =>
  page.waitForResponse(
    (res) => res.url().includes('/positions') && res.request().method() === 'PUT' && res.ok(),
  );

test('A03 a native reading returns to the scrolled place after another tab and after a reload', async ({
  page,
}) => {
  await page.goto(`${reading}?resource=${lab.native}`);
  await expect(page.getByText('Paragraph 1.', { exact: false }).first()).toBeVisible();

  const saved = savedPosition(page);
  await page.mouse.move(700, 500);
  await page.mouse.wheel(0, 3000);
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(2000);
  await saved;
  const placed = await scrollTop(page);

  await page.getByRole('tab', { name: 'Slides' }).click();
  await expect(page).toHaveURL(/\/slides/);
  await page.getByRole('tab', { name: 'Reading' }).click();
  await expect(page).toHaveURL(/\/reading/);
  await expect(page.getByText('Paragraph', { exact: false }).first()).toBeVisible();
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(placed - 100);
  expect(Math.abs((await scrollTop(page)) - placed)).toBeLessThan(100);

  // A fresh visit without any place in the address: the server's saved position restores it.
  await page.goto(reading);
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(placed - 100);
  expect(Math.abs((await scrollTop(page)) - placed)).toBeLessThan(100);
});

test('A03 a PDF reading returns to its page after another tab and after a reload, with a text layer', async ({
  page,
}) => {
  await page.goto(`${reading}?resource=${lab.pdf}`);
  const indicator = page.getByText(/Page \d+ of 4/);
  await expect(indicator).toHaveText('Page 1 of 4');
  await expect(page.locator('.textLayer')).toContainText('Sampling paper page 1');

  const saved = savedPosition(page);
  await page.getByRole('button', { name: 'Next page' }).click();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(indicator).toHaveText('Page 3 of 4');
  await expect(page.locator('.textLayer')).toContainText('Sampling paper page 3');
  await saved;

  await page.getByRole('tab', { name: 'Slides' }).click();
  await expect(page).toHaveURL(/\/slides/);
  await page.getByRole('tab', { name: 'Reading' }).click();
  await expect(page.getByText(/Page \d+ of 4/)).toHaveText('Page 3 of 4');

  await page.goto(reading);
  await expect(page.getByRole('combobox', { name: 'Reading' })).toHaveValue(lab.pdf);
  await expect(page.getByText(/Page \d+ of 4/)).toHaveText('Page 3 of 4');
  await expect(page.locator('.textLayer')).toContainText('Sampling paper page 3');
});

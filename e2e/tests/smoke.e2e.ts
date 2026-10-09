import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { E2E_PROBE_TOKEN } from '../paths';

test.use({ colorScheme: 'light' });

// The health line left the home page (/ now opens the courses); the check moved to the API.
test('P0 the API serves health and reaches the database', async ({ request }) => {
  const res = await request.get('/api/health', { headers: { 'X-Ready-Token': E2E_PROBE_TOKEN } });
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ status: 'ok', db: 'ok' });
  // Without the token the caller learns that the process answers, nothing more.
  expect(await (await request.get('/api/health')).json()).toEqual({ status: 'ok' });
});

test('P0 shell renders through the API', async ({ page }) => {
  await page.goto('/signin');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).toBe('rgb(255, 255, 255)');
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations).toEqual([]);
});

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.use({ colorScheme: 'light' });

// The health line left the home page (/ now opens the courses); the check moved to the API.
test('P0 the API serves health and reaches the database', async ({ request }) => {
  // Health shows the database state to probes only (READY_PROBE_TOKEN), so this reaches the
  // database through the sign-in fixture, which writes an account and a session.
  const res = await request.post('/api/test/signin-as', {
    data: { email: `smoke-${Date.now()}@example.test` },
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toHaveProperty('userId');
  // A caller without the probe token learns that the process answers, nothing more.
  const health = await request.get('/api/health');
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ status: 'ok' });
});

test('P0 shell renders through the API', async ({ page }) => {
  await page.goto('/signin');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).toBe('rgb(255, 255, 255)');
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations).toEqual([]);
});

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.use({ colorScheme: 'light' });

test('P0 shell renders through API and database', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Parallax' })).toBeVisible();
  await expect(page.getByText('API ok · database ok')).toBeVisible();
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).toBe('rgb(255, 255, 255)');
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations).toEqual([]);
});

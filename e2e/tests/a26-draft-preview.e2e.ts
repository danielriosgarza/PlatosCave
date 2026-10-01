import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.use({ colorScheme: 'light' });

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const course = id(101);
const classB = id(202);
const sampling = id(301);

test.beforeAll(async ({ playwright, baseURL }) => {
  const setup = await playwright.request.newContext({ baseURL });
  expect((await setup.post('/api/test/world')).ok()).toBe(true);
});

test('A26 an instructor previews the draft as a student and leaving returns to the editor', async ({
  page,
}) => {
  const signedIn = await page.request.post('/api/test/signin-as', {
    data: { email: 'marcus@example.test' },
  });
  expect(signedIn.ok()).toBe(true);
  await page.goto(`/courses/${course}/edit/${sampling}`);
  await expect(page.getByRole('heading', { name: 'Edit topic' })).toBeVisible();
  await expect(page.getByText('as a student of Autumn 2026 B')).toBeVisible();

  await page.getByRole('button', { name: 'Preview student view' }).click();
  await expect(page).toHaveURL(`/classes/${classB}/topics/${sampling}/reading`);
  const banner = page.getByRole('region', { name: 'Draft preview' });
  await expect(banner).toContainText('Statistical thinking as a student of Autumn 2026 B');
  await expect(page.getByRole('heading', { name: 'Sampling' })).toBeVisible();
  await expect(page.getByText('Preview student', { exact: true })).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations).toEqual([]);

  await banner.getByRole('button', { name: 'Exit draft preview' }).click();
  await expect(page).toHaveURL(`/courses/${course}/edit/${sampling}`);
  await expect(page.getByRole('heading', { name: 'Edit topic' })).toBeVisible();
  await expect(page.getByText('Marcus Webb')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Draft preview' })).toHaveCount(0);
});

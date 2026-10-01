import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { latestSignInLink } from './mail';

test.use({ colorScheme: 'light' });

async function signIn(page: Page, email: string) {
  await page.goto('/signin');
  await page.getByRole('button', { name: 'Student sign in' }).click();
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send sign-in link' }).click();
  await expect(page.getByText('Sign-in link requested')).toBeVisible();
  await page.goto(await latestSignInLink(email));
}

const SECRET_TITLE = 'Unreleased Bayesian methods';

test('A01 a link to an unpublished topic shows the neutral page and discloses nothing', async ({
  page,
  playwright,
  baseURL,
}) => {
  const owner = await playwright.request.newContext({ baseURL });
  const world = await (await owner.post('/api/test/world')).json();
  expect(
    (await owner.post('/api/test/signin-as', { data: { email: 'elena@example.test' } })).ok(),
  ).toBe(true);
  const draft = await owner.post(`/api/courses/${world.ids.statistics}/topics`, {
    data: { title: SECRET_TITLE, objective: 'Not yet published to any class.' },
  });
  expect(draft.ok()).toBe(true);
  const { id } = await draft.json();

  await signIn(page, 'sam@example.test');
  await page.goto(`/classes/${world.ids.classA}/topics/${id}/reading`);
  await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
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
  await signIn(page, 'bea@example.test');
  await page.goto(`/classes/${world.ids.classA}/topics/${world.ids.sampling}/reading`);
  await expect(page.getByRole('heading', { name: 'This page is not available' })).toBeVisible();
  const text = await page.locator('body').innerText();
  expect(text).not.toContain('Sampling');
  expect(text).not.toContain('Autumn 2026 A');
});

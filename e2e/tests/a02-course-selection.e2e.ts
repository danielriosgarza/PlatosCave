import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { latestSignInLink } from './mail';

test.use({ colorScheme: 'light' });

async function signIn(page: Page, email: string, entrance: 'Student' | 'Instructor') {
  await page.goto('/signin');
  await page.getByRole('button', { name: `${entrance} sign in` }).click();
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send sign-in link' }).click();
  await expect(page.getByText('Sign-in link requested')).toBeVisible();
  await page.goto(await latestSignInLink(email));
}

test.beforeAll(async ({ playwright, baseURL }) => {
  const setup = await playwright.request.newContext({ baseURL });
  expect((await setup.post('/api/test/world')).ok()).toBe(true);
});

test('A02 each context lists only its permissions: a student sees progress and Join, an instructor Class review and Create course', async ({
  page,
}) => {
  await signIn(page, 'sam@example.test', 'Student');
  await expect(page.getByRole('heading', { name: 'Your courses' })).toBeVisible();
  const cards = page.getByRole('list', { name: 'Your courses' });
  await expect(cards.getByRole('heading', { name: 'Statistical thinking' })).toBeVisible();
  await expect(cards.getByText('2 topics · Autumn 2026 A')).toBeVisible();
  await expect(cards.getByText('0 of 2 reviewed')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Join a class' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create course' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Class review' })).toHaveCount(0);
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations).toEqual([]);
});

test('A02 a person teaching class A and studying in class B switches between two separate lists', async ({
  page,
}) => {
  await signIn(page, 'priya@example.test', 'Instructor');
  await expect(page.getByRole('heading', { name: 'Courses you teach' })).toBeVisible();
  const taught = page.getByRole('list', { name: 'Classes you teach' });
  await expect(taught.getByText('2 topics · Autumn 2026 A')).toBeVisible();
  await expect(taught.getByText('Autumn 2026 B')).toHaveCount(0);
  await expect(taught.getByRole('link', { name: 'Class review' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create course' })).toBeVisible();

  await page.getByRole('link', { name: 'Student view' }).click();
  await expect(page.getByRole('heading', { name: 'Your courses' })).toBeVisible();
  const studied = page.getByRole('list', { name: 'Your courses' });
  await expect(studied.getByText('2 topics · Autumn 2026 B')).toBeVisible();
  await expect(studied.getByText('Autumn 2026 A')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Class review' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create course' })).toHaveCount(0);
});

test('A02 an empty account joins with a code, and a repeated code names its cause', async ({
  page,
  playwright,
  baseURL,
}) => {
  const owner = await playwright.request.newContext({ baseURL });
  const world = await (await owner.post('/api/test/world')).json();
  expect(
    (await owner.post('/api/test/signin-as', { data: { email: 'elena@example.test' } })).ok(),
  ).toBe(true);
  const issued = async (body: object) =>
    (await (await owner.post(`/api/classes/${world.ids.classA}/invites`, { data: body })).json())
      .code as string;
  const code = await issued({ kind: 'enrolment', maxUses: 1 });

  await signIn(page, `a02-join-${Date.now()}@example.test`, 'Student');
  await expect(page.getByRole('heading', { name: 'Join a class' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create course' })).toHaveCount(0);
  await page.getByLabel('Invitation code').fill(code);
  await page.getByRole('button', { name: 'Join class' }).click();
  await expect(page.getByRole('status')).toContainText(
    'You joined Statistical thinking · Autumn 2026 A.',
  );
  await expect(
    page.getByRole('list', { name: 'Your courses' }).getByRole('heading', {
      name: 'Statistical thinking',
    }),
  ).toBeVisible();

  // The single-use code is now spent: a second account is told why, from the dialog.
  const other = await page.context().browser()?.newContext();
  if (!other) throw new Error('no browser context');
  const second = await other.newPage();
  await signIn(second, `a02-join2-${Date.now()}@example.test`, 'Student');
  await second.getByLabel('Invitation code').fill(code);
  await second.getByRole('button', { name: 'Join class' }).click();
  await expect(second.getByRole('alert')).toContainText(
    'This class has reached its enrolment limit.',
  );
  await other.close();
});

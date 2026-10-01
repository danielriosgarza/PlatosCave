import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { latestSignInLink } from './mail';

test.use({ colorScheme: 'light' });

async function signIn(
  page: Page,
  email: string,
  entrance: 'Student' | 'Instructor',
  next?: string,
) {
  await page.goto(next ? `/signin?next=${encodeURIComponent(next)}` : '/signin');
  await page.getByRole('button', { name: `${entrance} sign in` }).click();
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send sign-in link' }).click();
  await expect(page.getByText('Sign-in link requested')).toBeVisible();
  await page.goto(await latestSignInLink(email));
}

test('A01 a student who uses the instructor entrance gets the access explanation, not instructor data', async ({
  page,
}) => {
  const email = `a01-${Date.now()}@example.test`;
  await signIn(page, email, 'Instructor');
  await expect(page).toHaveURL(/\/courses\?view=instructor$/);
  await expect(page.getByRole('heading', { name: 'Courses you teach' })).toBeVisible();
  await expect(page.getByText('This account has no instructor access')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Class review' })).toHaveCount(0);
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations).toEqual([]);
});

test('A01 an address opened while signed out is kept through sign-in', async ({ page }) => {
  const email = `a01-next-${Date.now()}@example.test`;
  await page.goto('/courses?view=student');
  await expect(page).toHaveURL(/\/signin\?next=%2Fcourses%3Fview%3Dstudent$/);
  await signIn(page, email, 'Student', '/courses?view=student');
  await expect(page).toHaveURL(/\/courses\?view=student$/);
  await expect(page.getByRole('heading', { name: 'Your courses' })).toBeVisible();
});

test('A01 a used sign-in link lands on the expired-link state', async ({ page }) => {
  const email = `a01-expired-${Date.now()}@example.test`;
  await signIn(page, email, 'Student');
  const link = await latestSignInLink(email);
  await page.context().clearCookies();
  await page.goto(link);
  await expect(page).toHaveURL(/\/signin\?link=expired/);
  await expect(page.getByText('This sign-in link no longer works')).toBeVisible();
});

test.describe('320 px', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('A19 sign-in and courses pages keep navigation reachable without page-wide horizontal scroll', async ({
    page,
  }) => {
    await page.goto('/signin');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send sign-in link' })).toBeVisible();
    const noScroll = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      );
    expect(await noScroll()).toBe(true);

    const email = `a19-${Date.now()}@example.test`;
    await signIn(page, email, 'Student');
    await expect(page.getByRole('link', { name: 'Courses' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    expect(await noScroll()).toBe(true);
  });
});

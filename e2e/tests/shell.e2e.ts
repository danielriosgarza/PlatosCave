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

test('A01 signed-out / lands on sign-in', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('A01 an instructor who signs in from / lands on the instructor view', async ({ page }) => {
  const email = `a01-root-${Date.now()}@example.test`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Instructor sign in' }).click();
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send sign-in link' }).click();
  await expect(page.getByText('Sign-in link requested')).toBeVisible();
  await page.goto(await latestSignInLink(email));
  await expect(page).toHaveURL(/\/courses\?view=instructor$/);
});

test('A02 signed-in / and the brand link land on courses', async ({ page }) => {
  const email = `a02-home-${Date.now()}@example.test`;
  await signIn(page, email, 'Student');
  await page.goto('/');
  await expect(page).toHaveURL(/\/courses/);
  await expect(page.getByRole('heading', { name: 'Your courses' })).toBeVisible();
  await page.goto('/courses?view=student#top');
  await page.getByRole('link', { name: 'Parallax' }).click();
  await expect(page).toHaveURL(/\/courses/);
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

test.describe('coarse pointer', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('A20 sign-in and courses controls, bar links and fields are at least 44 px with a touch screen', async ({
    page,
  }) => {
    const small = (selector: string) =>
      page.locator(selector).evaluateAll((nodes) =>
        nodes
          .map((node) => {
            const box = node.getBoundingClientRect();
            return { name: node.textContent?.trim() || node.getAttribute('name'), box };
          })
          .filter(({ box }) => box.width > 0 && (box.height < 44 || box.width < 44))
          .map(({ name, box }) => `${name}: ${Math.round(box.width)}x${Math.round(box.height)}`),
      );
    await page.goto('/signin');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeAttached();
    expect(await small('header a:not([class*="skip"]), main button, main input')).toEqual([]);

    await signIn(page, `a20-${Date.now()}@example.test`, 'Student');
    await expect(page.getByRole('heading', { name: 'Your courses' })).toBeVisible();
    expect(await small('header a, header button, main button, main input')).toEqual([]);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
});

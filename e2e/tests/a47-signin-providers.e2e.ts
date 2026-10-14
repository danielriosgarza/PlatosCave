import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

test.use({ colorScheme: 'light' });

// The e2e server has no provider configured (playwright.config.ts). The configured cases replace
// only the JSON answer of the methods request; the server's side of a provider sign-in is proven
// on real PostgreSQL in apps/server/test/integration/a47-provider-signin.itest.ts.
const university = { id: 'university', name: 'Example University' };
type Methods = { email: boolean; providers: { id: string; name: string }[] };

async function answerMethods(page: Page, methods: Methods) {
  await page.route('**/api/auth/methods', (route) => route.fulfill({ json: methods }));
}

async function expectNoAxeViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations).toEqual([]);
}

test('A47 with no provider configured the sign-in page offers the email link and no provider button', async ({
  page,
  request,
}) => {
  const methods = await request.get('/api/auth/methods');
  expect(await methods.json()).toEqual({ email: true, providers: [] });
  expect((await request.get('/api/auth/oidc/university/start')).status()).toBe(404);
  await page.goto('/signin?provider=university&refused=failed');
  await expect(page.getByRole('button', { name: 'Send sign-in link' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Sign in with / })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('A47 a configured provider shows a button that starts its sign-in, and axe passes', async ({
  page,
}) => {
  await answerMethods(page, { email: true, providers: [university] });
  await page.goto('/signin?next=%2Fcourses%3Fview%3Dinstructor');
  await page.getByRole('button', { name: 'Instructor sign in' }).click();
  const link = page.getByRole('link', { name: 'Sign in with Example University' });
  await expect(link).toBeVisible();
  await expectNoAxeViolations(page);
  // A link, so the browser navigates to the start route (a form would meet form-action 'self').
  const start = page.waitForRequest(
    (req) =>
      req.isNavigationRequest() &&
      new URL(req.url()).pathname === '/api/auth/oidc/university/start',
  );
  await link.click();
  const query = new URL((await start).url()).searchParams;
  expect(Object.fromEntries(query)).toEqual({
    entrance: 'instructor',
    next: '/courses?view=instructor',
  });
});

test('A47 with no mail sender the page offers no email link, and axe passes', async ({ page }) => {
  await answerMethods(page, { email: false, providers: [university] });
  await page.goto('/signin?link=expired');
  await expect(page.getByRole('link', { name: 'Sign in with Example University' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Student sign in' })).toBeVisible();
  await expect(page.getByLabel('Email address')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send sign-in link' })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expectNoAxeViolations(page);
});

test('A47 a refused provider sign-in is explained on the sign-in page, and axe passes', async ({
  page,
}) => {
  await answerMethods(page, { email: true, providers: [university] });
  await page.goto('/signin?provider=university&refused=unverified&next=%2Fcourses');
  const alert = page.getByRole('alert');
  await expect(
    alert.getByRole('heading', { name: 'Example University did not confirm an email address' }),
  ).toBeVisible();
  await expect(alert).toContainText('You can ask for an email link below.');
  await expect(page.getByRole('link', { name: 'Sign in with Example University' })).toHaveAttribute(
    'href',
    '/api/auth/oidc/university/start?entrance=student&next=%2Fcourses',
  );
  await expect(page.getByLabel('Email address')).toBeVisible();
  await expectNoAxeViolations(page);
});

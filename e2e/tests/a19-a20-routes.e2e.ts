import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

test.use({ colorScheme: 'light' });

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const lab = { course: id(111), class: id(211), topic: id(311) };
const topic = `/classes/${lab.class}/topics/${lab.topic}`;

type Route = { name: string; as: string | null; path: string; ready: RegExp | string };

// Every screen the application routes to, as the person who sees it.
const routes: Route[] = [
  { name: 'sign-in', as: null, path: '/signin', ready: 'Sign in' },
  {
    name: 'courses (student)',
    as: 'lab-reader',
    path: '/courses?view=student',
    ready: 'Your courses',
  },
  {
    name: 'courses (instructor)',
    as: 'lab-author',
    path: '/courses?view=instructor',
    ready: 'Courses you teach',
  },
  { name: 'topics', as: 'lab-reader', path: `/classes/${lab.class}/topics`, ready: /Reading lab/ },
  { name: 'slides', as: 'lab-reader', path: `${topic}/slides`, ready: /Slides/ },
  { name: 'reading', as: 'lab-reader', path: `${topic}/reading`, ready: /Reading/ },
  { name: 'exercises', as: 'lab-reader', path: `${topic}/exercises`, ready: /Exercises/ },
  { name: 'notebooks', as: 'lab-reader', path: `${topic}/notebooks`, ready: /Notebooks/ },
  { name: 'tests', as: 'lab-reader', path: `${topic}/tests`, ready: /Tests/ },
  {
    name: 'class review',
    as: 'lab-instructor',
    path: `/classes/${lab.class}/review`,
    ready: /Review/,
  },
  {
    name: 'course editor',
    as: 'lab-author',
    path: `/courses/${lab.course}/edit`,
    ready: /Reading lab/,
  },
  {
    name: 'topic editor',
    as: 'lab-author',
    path: `/courses/${lab.course}/edit/${lab.topic}`,
    ready: /Reading lab|Topic/,
  },
];

test.beforeAll(async ({ playwright, baseURL }) => {
  const setup = await playwright.request.newContext({ baseURL });
  expect((await setup.post('/api/test/world')).ok()).toBe(true);
});

async function open(page: Page, route: Route) {
  if (route.as) {
    const signedIn = await page.request.post('/api/test/signin-as', {
      data: { email: `${route.as}@example.test` },
    });
    expect(signedIn.ok()).toBe(true);
  }
  await page.goto(route.path);
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.locator('main').getByText(route.ready).first()).toBeVisible();
}

// Notebook outputs sit in sandboxed frames of the content origin: axe cannot enter them (they run
// no script), so they are left out here and the frame itself is checked to carry a title.
const analyse = async (page: Page) => {
  for (const frame of await page.locator('iframe').all()) {
    expect(await frame.getAttribute('title')).toBeTruthy();
  }
  return (await new AxeBuilder({ page }).exclude('iframe[sandbox]').analyze()).violations;
};

const pageScrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

for (const route of routes) {
  test(`A19 axe finds no violations on ${route.name}`, async ({ page }) => {
    await open(page, route);
    expect(await analyse(page)).toEqual([]);
  });

  test.describe(`${route.name} at 320 px`, () => {
    test.use({ viewport: { width: 320, height: 640 } });

    test(`A19 ${route.name} at 320 px and 200% text keeps the page from scrolling sideways`, async ({
      page,
    }) => {
      await open(page, route);
      expect(await pageScrollsSideways(page)).toBe(false);
      await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
      await expect(page.getByRole('main')).toBeVisible();
      expect(await pageScrollsSideways(page)).toBe(false);
      expect(await analyse(page)).toEqual([]);
    });
  });
}
